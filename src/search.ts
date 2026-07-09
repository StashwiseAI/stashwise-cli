// Direct, human-runnable search — use Stashwise from the terminal without
// wiring up an agent:
//
//   npx -y --package @stashwiseapp/mcp@latest mcp search "what did I save about HNSW"
//   npx -y --package @stashwiseapp/mcp@latest mcp search rust borrow checker --scope wiki --k 5
//
// Hits the same backend endpoint as the MCP `search_stashwise` tool, so it
// doubles as a quick way to verify the connection works.

import { ApiError, StashwiseApi, type AgentSearchResponse } from "./api.js";
import { STASHWISE_MCP_SEARCH_COMMAND } from "./commands.js";
import { loadConfig } from "./config.js";
import { getStoredToken } from "./keychain.js";
import { notAuthenticatedHint } from "./messages.js";

const SCOPES = ["library", "wiki", "all"] as const;
type Scope = (typeof SCOPES)[number];

interface ParsedSearchArgs {
  query: string;
  k: number;
  scope: Scope;
  error?: string;
}

const USAGE =
  `\nUsage: ${STASHWISE_MCP_SEARCH_COMMAND} "<query>" [--scope library|wiki|all] [--k 1-25]\n`;

export function parseSearchArgs(args: string[]): ParsedSearchArgs {
  const queryParts: string[] = [];
  let k = 8;
  let scope: Scope = "all";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const take = (inline: string | undefined): string | undefined =>
      inline !== undefined ? inline : args[(i += 1)];

    if (arg === "--k" || arg === "-k" || arg.startsWith("--k=")) {
      const raw = take(arg.startsWith("--k=") ? arg.slice(4) : undefined);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 25) {
        return { query: "", k, scope, error: `--k must be an integer 1–25 (got "${raw ?? ""}")` };
      }
      k = n;
    } else if (arg === "--scope" || arg === "-s" || arg.startsWith("--scope=")) {
      const raw = take(arg.startsWith("--scope=") ? arg.slice(8) : undefined);
      if (!SCOPES.includes(raw as Scope)) {
        return { query: "", k, scope, error: `--scope must be one of: ${SCOPES.join(", ")}` };
      }
      scope = raw as Scope;
    } else {
      queryParts.push(arg);
    }
  }

  return { query: queryParts.join(" ").trim(), k, scope };
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function printResults(res: AgentSearchResponse, scope: Scope): void {
  const lines: string[] = ["", `Results for "${res.query}" (scope: ${scope})`, ""];

  if (res.results.length === 0) {
    lines.push("  No matches found. Try a broader query, or save more to your library first.");
  } else {
    res.results.forEach((r, i) => {
      const meta = [r.source_platform, `score ${r.score.toFixed(2)}`]
        .filter(Boolean)
        .join("  ·  ");
      lines.push(`${String(i + 1).padStart(2)}. ${r.title}  ·  ${meta}`);
      if (r.snippet) lines.push(`    ${truncate(r.snippet, 200)}`);
      if (r.source_url) lines.push(`    ${r.source_url}`);
      lines.push("");
    });
  }

  const count = res.results.length;
  lines.push(`${count} result${count === 1 ? "" : "s"} · ${res.retrieval_ms}ms`, "");
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runSearch(args: string[]): Promise<number> {
  const parsed = parseSearchArgs(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (!parsed.query) {
    process.stderr.write(`Provide a search query.\n${USAGE}`);
    return 2;
  }

  const token = await getStoredToken();
  if (!token) {
    process.stderr.write(`${notAuthenticatedHint()}\n`);
    return 1;
  }

  const api = new StashwiseApi(loadConfig());
  try {
    const res = await api.search(token, parsed.query, parsed.k, parsed.scope);
    printResults(res, parsed.scope);
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      process.stderr.write(`${notAuthenticatedHint()}\n`);
      return 1;
    }
    process.stderr.write(
      `Search failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
