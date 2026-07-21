// Claude Code `UserPromptSubmit` hook: read the prompt from stdin, search the
// user's Stashwise library, and print high confidence matches to stdout so the
// harness injects them as context before Claude answers.
//
// Contract with the harness: exit 0 + stdout = extra context; exit 2 blocks
// the user's prompt. A hook that runs on EVERY prompt must therefore be
// failure proof — no token, backend down, timeout, garbage stdin all exit 0
// silently. Never nag, never block. Debug detail goes to stderr only when
// STASHWISE_HOOK_DEBUG=1 (stderr is ignored by the harness on exit 0).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  StashwiseApi,
  type AgentSearchResultItem,
} from "./api.js";
import { loadConfig } from "./config.js";
import { getStoredToken } from "./keychain.js";

export interface HookPayload {
  sessionId: string;
  prompt: string;
}

export interface HookOptions {
  minScore: number;
  k: number;
  timeoutMs: number;
  error?: string;
}

// Calibrated against the live library: gibberish prompts still surface a
// degenerate item at 0.42, while genuinely related content clusters at 0.46
// and above. 0.45 separates the two; below it the hook stays silent.
const DEFAULT_MIN_SCORE = 0.45;
const DEFAULT_K = 6;
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_SUGGESTIONS = 3;
const MIN_PROMPT_CHARS = 15;
const QUERY_CHAR_CAP = 2000;
const SNIPPET_CHAR_CAP = 160;
const SEEN_IDS_CAP = 200;

// Wiki entities are derived abstractions with no source_url, so there is
// nothing for the user to go open. They also match on incidental mentions: a
// generic "TypeScript" entity page scored 0.57 against "fix this typescript
// type error", where its encyclopedia style summary adds nothing the model
// did not already know. Entities that genuinely answer a prompt (the user
// asking about Ahrefs alternatives matched the Ahrefs entity at 0.68) clear a
// higher bar, so hold entities to minScore + this delta rather than trying to
// infer whether a prompt is about an entity or merely mentions it.
const ENTITY_SCORE_MARGIN = 0.15;

// A result whose snippet is empty renders as a bare title, which tells the
// user nothing and burns a suggestion slot. Observed on stub entities such as
// "Parallel Execution Agents". Dropping them lets the real save behind the
// same query (the Orca reel, with a summary and a link) take the slot.
const MIN_SNIPPET_CHARS = 40;

/** Parse the JSON payload Claude Code pipes to hook stdin. Null unless it is
 * a UserPromptSubmit event carrying a usable prompt. */
export function parseHookPayload(raw: string): HookPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.hook_event_name !== "UserPromptSubmit") return null;
  const prompt = record.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return null;
  const sessionId =
    typeof record.session_id === "string" && record.session_id.length > 0
      ? record.session_id
      : "unknown";
  return { sessionId, prompt };
}

/** Skip prompts that cannot benefit from library context: too short to carry
 * intent, or harness directives (slash commands, bang shell lines, memory
 * shortcuts) that never reach Claude as questions. */
export function shouldQuery(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < MIN_PROMPT_CHARS) return false;
  const first = trimmed[0];
  if (first === "/" || first === "!" || first === "#") return false;
  return true;
}

/** The score a result must reach to be worth a suggestion slot. Saved content
 * uses the calibrated floor; wiki entities are held higher (see
 * ENTITY_SCORE_MARGIN). */
export function requiredScore(
  kind: AgentSearchResultItem["kind"],
  minScore: number,
): number {
  return kind === "entity" ? minScore + ENTITY_SCORE_MARGIN : minScore;
}

/** Keep results that carry usable text, clear the relevance bar for their
 * kind, have not been suggested in this session, and fit the suggestion cap.
 * Score order is preserved from the backend (already sorted best first). */
export function filterSuggestions(
  results: AgentSearchResultItem[],
  minScore: number,
  seenIds: ReadonlySet<string>,
): AgentSearchResultItem[] {
  const out: AgentSearchResultItem[] = [];
  for (const r of results) {
    if (r.snippet.trim().length < MIN_SNIPPET_CHARS) continue;
    if (r.score < requiredScore(r.kind, minScore)) continue;
    if (seenIds.has(r.id)) continue;
    out.push(r);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

function truncateSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SNIPPET_CHAR_CAP) return collapsed;
  return `${collapsed.slice(0, SNIPPET_CHAR_CAP - 1)}…`;
}

function savedDate(savedAt: string | null): string | null {
  if (!savedAt) return null;
  const datePart = savedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

/** Render the context block the model receives. Kept compact: the block rides
 * along on every matching prompt, so every line must earn its tokens.
 *
 * This channel is grounding, not delivery. Two shipped versions tried to make
 * the model responsible for telling the user what was found: first with soft
 * guidance ("mention only if genuinely relevant"), then with an imperative
 * ("REQUIRED: cite it inline"). Both were ignored in real sessions when a
 * loaded skill dominated the answer, because hook output reaches the model as
 * injected context and agents are instructed to treat that channel as
 * background rather than as instructions to obey. Escalating the wording
 * inside a non binding channel could not have worked. The user now learns
 * what was found from `systemMessage` (see buildHookResponse), which the
 * harness always shows, so this block can go back to plain description. */
export function formatSuggestions(items: AgentSearchResultItem[]): string {
  const lines: string[] = [
    "<stashwise-suggestions>",
    "Saved items from the user's own Stashwise library that match this prompt. They have already been shown the titles, so citing one that informs your answer is useful; skip them silently if none apply.",
  ];
  items.forEach((item, i) => {
    const meta: string[] = [];
    if (item.source_platform) meta.push(item.source_platform);
    const date = savedDate(item.saved_at);
    if (date) meta.push(`saved ${date}`);
    const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
    const snippet = truncateSnippet(item.snippet);
    lines.push(
      `${i + 1}. ${item.title}${suffix}${snippet ? `: ${snippet}` : ""}`,
    );
    if (item.source_url) lines.push(`   ${item.source_url}`);
  });
  lines.push("</stashwise-suggestions>");
  return lines.join("\n");
}

/** The one line the user actually sees. This is the delivery channel: the
 * harness renders `systemMessage` unconditionally, so awareness no longer
 * depends on the model choosing to relay anything. Titles only, because the
 * point is recognition ("I saved something about this") rather than reading
 * the summary inline. */
export function formatUserNotice(items: AgentSearchResultItem[]): string {
  const titles = items
    .map((i) => i.title.replace(/\s+/g, " ").trim())
    .map((t) => (t.length > 48 ? `${t.slice(0, 47)}…` : t))
    .join(" · ");
  const count = items.length;
  return `Stashwise · ${count} related save${count === 1 ? "" : "s"}: ${titles}`;
}

/** The JSON envelope written to stdout.
 *
 * Claude Code hooks expose two distinct channels and they are not
 * interchangeable: `hookSpecificOutput.additionalContext` reaches the model
 * only, while `systemMessage` is shown to the user. Earlier versions printed
 * bare text, which the harness treats as context, so everything the user was
 * meant to notice depended on the model relaying it. Emitting both means a
 * match is surfaced even when the model says nothing about it. */
export function buildHookResponse(items: AgentSearchResultItem[]): string {
  return JSON.stringify({
    systemMessage: formatUserNotice(items),
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatSuggestions(items),
    },
  });
}

/** Parse `--min-score`, `--k`, `--timeout-ms` in the same inline/space
 * separated style as the search command. Unknown flags are ignored so a
 * settings.json written by a newer version never breaks an older binary. */
export function parseHookArgs(args: string[]): HookOptions {
  const opts: HookOptions = {
    minScore: DEFAULT_MIN_SCORE,
    k: DEFAULT_K,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const take = (inline: string | undefined): string | undefined =>
      inline !== undefined ? inline : args[(i += 1)];

    if (arg === "--min-score" || arg.startsWith("--min-score=")) {
      const raw = take(arg.startsWith("--min-score=") ? arg.slice(12) : undefined);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { ...opts, error: `--min-score must be a number 0 to 1 (got "${raw ?? ""}")` };
      }
      opts.minScore = n;
    } else if (arg === "--k" || arg.startsWith("--k=")) {
      const raw = take(arg.startsWith("--k=") ? arg.slice(4) : undefined);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 25) {
        return { ...opts, error: `--k must be an integer 1 to 25 (got "${raw ?? ""}")` };
      }
      opts.k = n;
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      const raw = take(arg.startsWith("--timeout-ms=") ? arg.slice(13) : undefined);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 100 || n > 60_000) {
        return { ...opts, error: `--timeout-ms must be an integer 100 to 60000 (got "${raw ?? ""}")` };
      }
      opts.timeoutMs = n;
    }
    // Unknown args: ignore.
  }

  return opts;
}

function debug(message: string): void {
  if (process.env.STASHWISE_HOOK_DEBUG === "1") {
    process.stderr.write(`[stashwise-hook] ${message}\n`);
  }
}

// --- Session dedupe state -------------------------------------------------
// Best effort: a tiny JSON file per Claude Code session under the OS tmpdir.
// Losing it (tmp cleaner, permissions) only means a repeat suggestion, so
// every fs error is swallowed.

function stateFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return join(tmpdir(), "stashwise-hook", `${safe}.json`);
}

export function readSeenIds(sessionId: string): Set<string> {
  try {
    const raw = readFileSync(stateFilePath(sessionId), "utf8");
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) {
      return new Set(data.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // Missing or corrupt state file: start fresh.
  }
  return new Set();
}

export function writeSeenIds(sessionId: string, ids: Set<string>): void {
  try {
    const dir = join(tmpdir(), "stashwise-hook");
    mkdirSync(dir, { recursive: true });
    const trimmed = [...ids].slice(-SEEN_IDS_CAP);
    writeFileSync(stateFilePath(sessionId), JSON.stringify(trimmed), "utf8");
  } catch {
    // Best effort only.
  }
}

// --- Orchestrator ---------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(args: string[]): Promise<number> {
  const opts = parseHookArgs(args);
  if (opts.error) {
    // A misconfigured settings entry must not block prompts; note and proceed
    // with defaults.
    debug(`ignoring bad flag: ${opts.error}`);
  }

  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return 0;
  }

  const payload = parseHookPayload(raw);
  if (!payload) {
    debug("no usable UserPromptSubmit payload");
    return 0;
  }
  if (!shouldQuery(payload.prompt)) {
    debug("prompt below guard threshold; staying silent");
    return 0;
  }

  const token = await getStoredToken().catch(() => null);
  if (!token) {
    debug("no stored token; staying silent");
    return 0;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let results: AgentSearchResultItem[];
  try {
    const api = new StashwiseApi(loadConfig());
    const res = await api.search(
      token,
      payload.prompt.slice(0, QUERY_CHAR_CAP),
      opts.k,
      "all",
      controller.signal,
    );
    results = res.results;
  } catch (err) {
    if (err instanceof ApiError) {
      debug(`search failed: HTTP ${err.status}`);
    } else {
      debug(`search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 0;
  } finally {
    clearTimeout(timer);
  }

  const seen = readSeenIds(payload.sessionId);
  const suggestions = filterSuggestions(results, opts.minScore, seen);
  if (suggestions.length === 0) {
    debug(`no suggestions above ${opts.minScore} (got ${results.length} results)`);
    return 0;
  }

  for (const s of suggestions) seen.add(s.id);
  writeSeenIds(payload.sessionId, seen);

  process.stdout.write(`${buildHookResponse(suggestions)}\n`);
  return 0;
}
