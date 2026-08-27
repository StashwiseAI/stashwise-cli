// `stashwise install` — find the AI tools on this machine and configure them all.
//
// The one line the homepage prints. Everything else in this package assumed the
// user had already been told which file to edit; this is the command that means
// they never have to be.
//
// Order of operations matters and is not the obvious one:
//
//   probe before writing. `hook-install.ts` writes first and verifies after,
//   which is right when the file belongs to the user. These files belong to
//   other applications, and a broken stdio entry makes an editor show an error
//   banner on every launch, so it is worth proving the command runs before
//   putting it anywhere.
//
//   auth last. The config writes are where the interesting failures are, and a
//   cancelled sign in still leaves correct configs that `stashwise auth`
//   finishes later.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { runAuth } from "./auth.js";
import {
  CLIENTS,
  HOSTED_MCP_URL,
  detectClients,
  entryFor,
  type ClientId,
  type CliClientSpec,
  type Detection,
  type PathEnv,
} from "./clients.js";
import { readJsonConfig, writeJsonConfig } from "./config-file.js";
import { installCodex, uninstallCodex } from "./codex-mcp.js";
import { runHookInstall } from "./hook-install.js";
import { getStoredToken } from "./keychain.js";
import {
  installServerEntry,
  isStashwiseServerEntry,
  removeServerEntry,
} from "./mcp-config.js";

export type Status =
  | "installed"
  | "updated"
  | "unchanged"
  | "manual"
  | "absent"
  | "refused"
  | "failed";

export interface ClientResult {
  id: ClientId;
  label: string;
  status: Status;
  detail?: string;
  restartRequired: boolean;
}

export interface InstallOptions {
  dryRun: boolean;
  only: ClientId[] | null;
  yes: boolean;
  auth: boolean;
  hook: boolean;
  force: boolean;
}

export function parseInstallArgs(args: string[]): InstallOptions | { error: string } {
  const options: InstallOptions = {
    dryRun: false,
    only: null,
    yes: false,
    auth: true,
    hook: true,
    force: false,
  };
  const ids = new Set(CLIENTS.map((c) => c.id as string));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-y" || arg === "--yes") options.yes = true;
    else if (arg === "--no-auth") options.auth = false;
    else if (arg === "--no-hook") options.hook = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--only" || arg.startsWith("--only=")) {
      const raw = arg.startsWith("--only=") ? arg.slice(7) : args[(i += 1)];
      if (!raw) return { error: "--only needs a client id" };
      const chosen = raw.split(",").map((s) => s.trim());
      const unknown = chosen.filter((c) => !ids.has(c));
      if (unknown.length) {
        return { error: `unknown client: ${unknown.join(", ")}. Known: ${[...ids].join(", ")}` };
      }
      options.only = chosen as ClientId[];
    } else return { error: `unknown flag: ${arg}` };
  }
  return options;
}

/**
 * Is the server there, and is it the one we think?
 *
 * Nothing runs locally any more, so the old probe, which started npx and asked
 * it for a version, no longer describes anything a client will do. What a
 * client actually does first is dial the URL unauthenticated and read the
 * challenge, so that is what we check: a 401 carrying a WWW-Authenticate that
 * points back at this same host. A 200 would mean an open endpoint, and
 * anything else means the address is wrong.
 */
async function probeHosted(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json, text/event-stream" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 401) {
      return { ok: false, detail: `expected an authentication challenge, got ${response.status}` };
    }
    const challenge = response.headers.get("www-authenticate") ?? "";
    const host = new URL(url).host;
    if (!challenge.includes(host)) {
      return {
        ok: false,
        detail: "the server points somewhere else for authentication, which strict clients reject",
      };
    }
    return { ok: true, detail: "reachable, and asks for sign in" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function ask(question: string): Promise<boolean> {
  // A prompt into a pipe hangs forever, so a non interactive run answers no and
  // says how to do it on purpose.
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const MARK: Record<Status, string> = {
  installed: "+",
  updated: "~",
  unchanged: "=",
  manual: "!",
  absent: ".",
  refused: "x",
  failed: "x",
};

/** Statuses that assert something changed on disk. */
const CHANGED: Status[] = ["installed", "updated"];

/**
 * The summary table.
 *
 * The dry run marker is added here, once, rather than by each writer. Three
 * separate bugs came from asking every code path to remember to say it: the
 * Codex row claimed a plain "installed" beside rows that admitted they were
 * hypothetical, and uninstall's preview was byte identical to the real thing.
 * A dry run's only product is its output, so an unmarked row is not a cosmetic
 * slip, it is the whole failure.
 */
export function renderSummary(results: ClientResult[], dryRun = false): string {
  const lines: string[] = [];
  const width = Math.max(...results.map((r) => r.label.length), 0);
  for (const result of results) {
    const marker = dryRun && CHANGED.includes(result.status) ? "dry run" : "";
    const detail = [result.detail, marker].filter(Boolean).join("  ");
    lines.push(
      `  ${MARK[result.status]}  ${result.label.padEnd(width)}  ${result.status}${detail ? `  ${detail}` : ""}`,
    );
  }
  const restart = results
    .filter((r) => r.restartRequired && (r.status === "installed" || r.status === "updated"))
    .map((r) => r.label);
  if (restart.length && !dryRun) {
    const named =
      restart.length === 1
        ? restart[0]
        : `${restart.slice(0, -1).join(", ")} and ${restart[restart.length - 1]}`;
    lines.push("", `  Restart ${named} to pick up the change.`);
  }
  return lines.join("\n");
}

/** What this client currently has registered for us, read from its own config. */
function readCurrentUrl(spec: CliClientSpec, configPath: string | null): string | null {
  if (!configPath) return null;
  const read = readJsonConfig(configPath);
  if (read.kind !== "json" || !read.doc) return null;
  const servers = read.doc.mcpServers;
  if (typeof servers !== "object" || servers === null) return null;
  for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!isStashwiseServerEntry(value, key)) continue;
    const entry = value as Record<string, unknown>;
    // Gemini names the streamable transport `httpUrl`; the others use `url`.
    for (const field of ["url", "httpUrl"]) {
      if (typeof entry[field] === "string") return entry[field] as string;
    }
    return "";
  }
  return null;
}

/**
 * Let a client register its own server.
 *
 * Claude Code, Codex and Gemini each ship an `mcp add` that speaks http. Using
 * it means the client parses and validates its own config, so "we wrote it" and
 * "it works" stop being separate claims, and we never reformat a file another
 * program owns.
 *
 * Codex is the one that also gets its file checked afterwards: its config is
 * hand written TOML full of comments, and a rewrite that flattened them would
 * be silent otherwise.
 */
function installViaCli(spec: CliClientSpec, configPath: string | null, dryRun: boolean): ClientResult {
  const base = { id: spec.id, label: spec.label, restartRequired: spec.restartRequired };
  if (spec.id === "codex") {
    const outcome = installCodex(HOSTED_MCP_URL, {
      configPath: configPath ?? "",
      dryRun,
      spec,
    });
    if (outcome.status === "unchanged") return { ...base, status: "unchanged" };
    if (outcome.status === "managed") {
      return { ...base, status: "unchanged", detail: outcome.reason };
    }
    if (outcome.status === "failed") return { ...base, status: "failed", detail: outcome.reason };
    return { ...base, status: outcome.replaced ? "updated" : "installed" };
  }

  // Read the client's own config to decide what is there, rather than grepping
  // the CLI's output. The first attempt searched `claude mcp list` for our URL
  // and found it inside the connection *error message*, so a broken entry
  // reported itself as already correct. Reading is safe; it is writing these
  // files that we delegate.
  const currentUrl = readCurrentUrl(spec, configPath);
  if (currentUrl === HOSTED_MCP_URL) return { ...base, status: "unchanged" };
  const already = currentUrl !== null;
  if (dryRun) return { ...base, status: already ? "updated" : "installed" };
  try {
    const quiet = {
      encoding: "utf8" as const,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[],
    };
    if (already) execFileSync(spec.bin, spec.removeArgs, quiet);
    execFileSync(spec.bin, spec.addArgs(HOSTED_MCP_URL), quiet);
  } catch (err) {
    return {
      ...base,
      status: "failed",
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
  return { ...base, status: already ? "updated" : "installed" };
}

function writeClient(
  detection: Detection,
  entry: Record<string, unknown>,
  dryRun: boolean,
): ClientResult {
  const { spec, configPath } = detection;
  const base = { id: spec.id, label: spec.label, restartRequired: spec.restartRequired };
  if (spec.kind !== "json" || configPath === null) {
    return { ...base, status: "failed", detail: "no config path on this platform" };
  }
  const read = readJsonConfig(configPath);
  if (read.kind === "jsonc") {
    // Their file, their comments. Stripping them to make room for us is not a
    // trade we get to make on someone's behalf.
    return { ...base, status: "manual", detail: `${configPath} has comments; add it by hand` };
  }
  if (read.kind === "corrupt" || read.kind === "not-object") {
    return { ...base, status: "refused", detail: `${configPath} is not valid JSON` };
  }
  const doc = read.doc ?? {};
  const merged = installServerEntry(doc, spec.containerKey, entry);
  if (merged.action === "refused") {
    return { ...base, status: "refused", detail: merged.reason };
  }
  if (!merged.changed) return { ...base, status: "unchanged" };
  if (dryRun) {
    return { ...base, status: merged.action === "created" ? "installed" : "updated" };
  }
  try {
    // No rootDir guard here on purpose. Detection is the gate that stops us
    // littering onto a machine without the tool, and by this point it has
    // already said yes. A client found by its binary may legitimately have no
    // config directory yet, which is the ordinary case of someone who has the
    // tool but has never configured an MCP server in it; refusing that would
    // report "not installed" for something we just found.
    writeJsonConfig(configPath, merged.doc, {
      mode: read.mode,
      indent: read.indent,
    });
  } catch (err) {
    return { ...base, status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  const removed = merged.removedKeys.length
    ? `replaced ${merged.removedKeys.length + 1} entries`
    : undefined;
  return {
    ...base,
    status: merged.action === "created" ? "installed" : "updated",
    detail: removed,
  };
}

export async function runInstall(args: string[]): Promise<number> {
  const parsed = parseInstallArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const options = parsed;
  const env: PathEnv = {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    kimiCodeHome: process.env.KIMI_CODE_HOME,
  };
  const detections = detectClients(env, {
    exists: existsSync,
    onPath: (bin) =>
      (process.env.PATH ?? "")
        .split(delimiter)
        .some((dir) => dir && existsSync(join(dir, bin))),
  }).filter((d) => !options.only || options.only.includes(d.spec.id));

  const present = detections.filter((d) => d.installed);
  process.stdout.write(
    options.dryRun ? "\nStashwise install (dry run)\n\n" : "\nStashwise install\n\n",
  );
  if (present.length === 0) {
    process.stdout.write("  No supported AI tools found on this machine.\n\n");
    return 0;
  }

  process.stdout.write("  Checking the Stashwise server...\n");
  const reachable = await probeHosted(HOSTED_MCP_URL);
  if (!reachable.ok && !options.force) {
    process.stderr.write(
      `  ${reachable.detail}\n  Nothing was changed. Rerun with --force to configure anyway.\n\n`,
    );
    return 1;
  }
  process.stdout.write(`    ${reachable.detail}\n\n`);

  // Everything starts absent; the loop below fills in whatever is installed.
  const results: ClientResult[] = detections.map((d) => ({
    id: d.spec.id,
    label: d.spec.label,
    status: "absent" as Status,
    restartRequired: d.spec.restartRequired,
  }));

  for (let i = 0; i < detections.length; i += 1) {
    const detection = detections[i];
    if (!detection.installed) continue;
    if (detection.spec.kind === "manual") {
      results[i] = {
        id: detection.spec.id,
        label: detection.spec.label,
        restartRequired: detection.spec.restartRequired,
        status: "manual",
        detail: detection.spec.instruction,
      };
      continue;
    }
    if (detection.spec.kind === "cli") {
      results[i] = installViaCli(detection.spec, detection.configPath, options.dryRun);
      continue;
    }
    results[i] = writeClient(detection, entryFor(detection.spec), options.dryRun);
  }

  process.stdout.write(`${renderSummary(results, options.dryRun)}\n\n`);

  if (options.dryRun) {
    process.stdout.write("  Dry run: nothing was written.\n\n");
    return 0;
  }

  // No token is needed any more. The hosted server authenticates each client
  // over OAuth, so the first time a tool connects it opens a browser and the
  // reader approves it there. Signing in here would store a credential that
  // nothing consumes, except the terminal search and the optional prompt hook
  // below, which is why `stashwise auth` still exists and is no longer run for
  // you.
  process.stdout.write(
    "  Each tool will ask you to approve Stashwise in your browser the first\n" +
      "  time it connects. Nothing is stored on this machine.\n",
  );

  const configuredClaude = results.some(
    (r) => r.id === "claude-code" && (r.status === "installed" || r.status === "updated"),
  );
  if (options.hook && configuredClaude && !options.yes) {
    const wanted = await ask("\n  Search your library on every Claude Code prompt?");
    if (wanted) {
      // The hook runs locally and reads the library through this package, so
      // unlike the MCP servers above it does need a token of its own.
      if (!(await getStoredToken())) await runAuth();
      await runHookInstall();
    } else if (!process.stdin.isTTY) {
      process.stdout.write("  Skipped the prompt hook. Enable it with: stashwise hook install\n");
    }
  }

  const failed = results.some((r) => r.status === "failed" || r.status === "refused");
  process.stdout.write("\n  Done.\n\n");
  return failed ? 1 : 0;
}

export async function runUninstall(args: string[]): Promise<number> {
  const parsed = parseInstallArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const env: PathEnv = {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    kimiCodeHome: process.env.KIMI_CODE_HOME,
  };
  const detections = detectClients(env, {
    exists: existsSync,
    onPath: (bin) =>
      (process.env.PATH ?? "")
        .split(delimiter)
        .some((dir) => dir && existsSync(join(dir, bin))),
  }).filter((d) => d.installed);

  process.stdout.write(
    parsed.dryRun ? "\nRemoving Stashwise (dry run)\n\n" : "\nRemoving Stashwise\n\n",
  );
  for (const detection of detections) {
    // Codex wrote its own config, so it removes its own entry. Editing the
    // TOML ourselves here would carry every risk the install path avoids.
    if (detection.spec.kind === "cli") {
      const { removed, reason } = uninstallCodex({
        configPath: detection.configPath ?? "",
        dryRun: parsed.dryRun,
      });
      if (removed) process.stdout.write(`  - ${detection.spec.label}\n`);
      else if (reason) process.stdout.write(`  ! ${detection.spec.label}: ${reason}\n`);
      continue;
    }
    const path = detection.configPath;
    if (!path) continue;
    const read = readJsonConfig(path);
    if (read.kind !== "json" || !read.doc) continue;
    const { doc, removedKeys } = removeServerEntry(read.doc, (detection.spec as { containerKey: string }).containerKey);
    if (removedKeys.length === 0) continue;
    if (!parsed.dryRun) {
      writeJsonConfig(path, doc, { mode: read.mode, indent: read.indent });
    }
    process.stdout.write(`  - ${detection.spec.label}\n`);
  }
  process.stdout.write(
    parsed.dryRun
      ? "\n  Dry run: nothing was removed. Your saved library is untouched either way.\n\n"
      : "\n  Done. Your saved library is untouched.\n\n",
  );
  return 0;
}
