// Codex configures itself, so we ask it to.
//
// `~/.codex/config.toml` is hand written and full of comments and sub tables.
// Editing TOML while preserving all of that means writing a TOML parser, and
// the failure mode of getting it wrong is not "our entry is wrong", it is a
// duplicate key that makes Codex refuse to load the file at all, taking every
// other MCP server the user has with it. So we drive `codex mcp` instead, the
// way `scripts/install-codex-plugin.sh` already drives `codex plugin`.
//
// That trades a parser we cannot safely write for a promise we cannot verify:
// that Codex preserves the rest of the file. The invariant below turns that
// promise into a checked postcondition with a restore path, which is better
// than having verified it once against one version.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { isStashwiseServerEntry } from "./mcp-config.js";

export interface CodexRunner {
  run(args: string[]): string;
}

export const realCodex: CodexRunner = {
  run(args) {
    return execFileSync("codex", args, { encoding: "utf8", timeout: 60_000 });
  },
};

export type CodexOutcome =
  | { status: "unchanged" }
  | { status: "installed"; replaced: boolean; backupPath: string | null }
  | { status: "failed"; reason: string };

/** Lines outside our own block, which must survive whatever Codex does. */
function foreignLines(raw: string): string[] {
  const out: string[] = [];
  let inOurBlock = false;
  for (const line of raw.split("\n")) {
    const header = line.match(/^\s*\[+\s*mcp_servers\.([^.\]]+)/);
    if (header) inOurBlock = header[1].replace(/["']/g, "") === "stashwise";
    if (!inOurBlock && line.trim() !== "") out.push(line);
  }
  return out;
}

function existing(codex: CodexRunner): { present: boolean; matches: boolean; entry: unknown } {
  let listed: unknown;
  try {
    listed = JSON.parse(codex.run(["mcp", "list", "--json"]));
  } catch {
    return { present: false, matches: false, entry: null };
  }
  const rows = Array.isArray(listed)
    ? listed
    : Object.entries((listed ?? {}) as Record<string, unknown>).map(([name, value]) => ({
        name,
        ...(value as object),
      }));
  for (const row of rows as Array<Record<string, unknown>>) {
    const name = typeof row.name === "string" ? row.name : "";
    const transport = (row.transport ?? row) as Record<string, unknown>;
    if (isStashwiseServerEntry(transport, name) || name === "stashwise") {
      return { present: true, matches: false, entry: transport };
    }
  }
  return { present: false, matches: false, entry: null };
}

export function installCodex(
  argv: { command: string; args: string[] },
  options: { configPath: string; codex?: CodexRunner; dryRun?: boolean },
): CodexOutcome {
  const codex = options.codex ?? realCodex;
  const found = existing(codex);

  const desired = [argv.command, ...argv.args].join(" ");
  if (found.present) {
    const current = found.entry as Record<string, unknown>;
    const currentLine = [
      typeof current.command === "string" ? current.command : "",
      ...(Array.isArray(current.args) ? current.args : []),
    ].join(" ");
    if (currentLine === desired) return { status: "unchanged" };
  }
  if (options.dryRun) {
    return { status: "installed", replaced: found.present, backupPath: null };
  }

  const before = existsSync(options.configPath)
    ? readFileSync(options.configPath, "utf8")
    : null;
  let backupPath: string | null = null;
  if (before !== null) {
    backupPath = `${options.configPath}.stashwise-backup`;
    copyFileSync(options.configPath, backupPath);
  }

  try {
    if (found.present) codex.run(["mcp", "remove", "stashwise"]);
    codex.run(["mcp", "add", "stashwise", "--", argv.command, ...argv.args]);
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }

  // The postcondition: everything that was not ours is still there. A rewrite
  // that flattened the user's comments or dropped another server shows up here
  // rather than a week later.
  if (before !== null && existsSync(options.configPath)) {
    const after = readFileSync(options.configPath, "utf8");
    const lost = foreignLines(before).filter((line) => !after.includes(line.trim()));
    if (lost.length > 0) {
      if (backupPath) copyFileSync(backupPath, options.configPath);
      return {
        status: "failed",
        reason: `codex rewrote ${lost.length} unrelated line(s); restored from backup`,
      };
    }
  }

  try {
    codex.run(["mcp", "get", "stashwise", "--json"]);
  } catch (err) {
    return { status: "failed", reason: `codex did not accept the entry: ${String(err)}` };
  }
  return { status: "installed", replaced: found.present, backupPath };
}
