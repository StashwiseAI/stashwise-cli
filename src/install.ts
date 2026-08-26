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

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { runAuth } from "./auth.js";
import {
  CLIENTS,
  detectClients,
  entryFor,
  guiPath,
  serverArgv,
  type ClientId,
  type Detection,
  type PathEnv,
} from "./clients.js";
import { readJsonConfig, writeJsonConfig } from "./config-file.js";
import { installCodex, uninstallCodex } from "./codex-mcp.js";
import { npxPrefixDir, runHookInstall } from "./hook-install.js";
import { getStoredToken } from "./keychain.js";
import { installServerEntry, removeServerEntry } from "./mcp-config.js";

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

const PROBE_TIMEOUT_MS = 60_000;

/**
 * Prove the server actually starts before we point anyone at it.
 *
 * Spawned as argv rather than through a shell, because that is how an MCP host
 * spawns it. Verifying a shell invocation would be verifying something that
 * never happens.
 */
function probe(
  argv: { command: string; args: string[] },
  env?: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      argv.command,
      [...argv.args, "--version"],
      {
        timeout: PROBE_TIMEOUT_MS,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      },
      (err, stdout) => {
        const version = String(stdout ?? "").trim();
        if (!err && /^\d+\.\d+\.\d+/.test(version)) {
          resolve({ ok: true, detail: version });
          return;
        }
        const reason = err && "killed" in err && err.killed ? "timed out" : String(err ?? "no version");
        resolve({ ok: false, detail: reason.split("\n")[0] });
      },
    );
  });
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

export function renderSummary(results: ClientResult[]): string {
  const lines: string[] = [];
  const width = Math.max(...results.map((r) => r.label.length), 0);
  for (const result of results) {
    const detail = result.detail ? `  ${result.detail}` : "";
    lines.push(`  ${MARK[result.status]}  ${result.label.padEnd(width)}  ${result.status}${detail}`);
  }
  const restart = results
    .filter((r) => r.restartRequired && (r.status === "installed" || r.status === "updated"))
    .map((r) => r.label);
  if (restart.length) {
    const named =
      restart.length === 1
        ? restart[0]
        : `${restart.slice(0, -1).join(", ")} and ${restart[restart.length - 1]}`;
    lines.push("", `  Restart ${named} to pick up the change.`);
  }
  return lines.join("\n");
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
    return { ...base, status: merged.action === "created" ? "installed" : "updated", detail: "dry run" };
  }
  try {
    writeJsonConfig(configPath, merged.doc, {
      rootDir: detection.rootDir ?? undefined,
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
  };
  const detections = detectClients(env, {
    exists: existsSync,
    onPath: (bin) =>
      (process.env.PATH ?? "")
        .split(delimiter)
        .some((dir) => dir && existsSync(join(dir, bin))),
  }).filter((d) => !options.only || options.only.includes(d.spec.id));

  const present = detections.filter((d) => d.installed);
  process.stdout.write("\nStashwise install\n\n");
  if (present.length === 0) {
    process.stdout.write("  No supported AI tools found on this machine.\n\n");
    return 0;
  }

  const prefix = npxPrefixDir();
  // `npx --prefix` fails with ENOENT when the directory does not exist, which
  // on a machine that has never run Stashwise it does not. This is ours to
  // create, unlike every client directory below.
  mkdirSync(prefix, { recursive: true });
  const argv = serverArgv(prefix);

  process.stdout.write("  Checking the server starts...\n");
  const direct = await probe(argv);
  if (!direct.ok && !options.force) {
    process.stderr.write(
      `  Could not start the server: ${direct.detail}\n` +
        "  Nothing was changed. Rerun with --force to configure anyway.\n\n",
    );
    return 1;
  }
  process.stdout.write(`    ok, version ${direct.detail}\n`);

  const hasGui = present.some((d) => d.spec.launch === "gui");
  if (hasGui) {
    // The failure this catches: npx on PATH for a terminal but not for an app
    // launched by the window manager, which is how a "successful" install ends
    // up doing nothing in Cursor.
    const gui = await probe(argv, { PATH: guiPath(process.execPath) });
    process.stdout.write(
      gui.ok
        ? "    ok under a desktop app's PATH\n"
        : `    warning: not resolvable under a desktop app's PATH (${gui.detail})\n`,
    );
  }
  process.stdout.write("\n");

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
    if (detection.spec.kind === "cli") {
      const outcome = installCodex(argv, {
        configPath: detection.configPath ?? "",
        dryRun: options.dryRun,
      });
      results[i] = {
        id: detection.spec.id,
        label: detection.spec.label,
        restartRequired: detection.spec.restartRequired,
        status:
          outcome.status === "unchanged"
            ? "unchanged"
            : outcome.status === "managed"
              ? "unchanged"
              : outcome.status === "failed"
                ? "failed"
                : outcome.replaced
                  ? "updated"
                  : "installed",
        detail:
          outcome.status === "failed" || outcome.status === "managed"
            ? outcome.reason
            : undefined,
      };
      continue;
    }
    results[i] = writeClient(
      detection,
      entryFor(detection.spec, prefix, process.execPath),
      options.dryRun,
    );
  }

  process.stdout.write(`${renderSummary(results)}\n\n`);

  if (options.dryRun) {
    process.stdout.write("  Dry run: nothing was written.\n\n");
    return 0;
  }

  if (options.auth) {
    const token = await getStoredToken();
    if (token) {
      process.stdout.write("  Already signed in.\n\n");
    } else {
      const code = await runAuth();
      if (code !== 0) {
        process.stdout.write("\n  Configured, but not signed in. Run: stashwise auth\n\n");
        return code;
      }
    }
  }

  const configuredClaude = results.some(
    (r) => r.id === "claude-code" && (r.status === "installed" || r.status === "updated"),
  );
  if (options.hook && configuredClaude && !options.yes) {
    const wanted = await ask("\n  Search your library on every Claude Code prompt?");
    if (wanted) await runHookInstall();
    else if (!process.stdin.isTTY) {
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
  const env: PathEnv = { home: homedir(), platform: process.platform, appData: process.env.APPDATA };
  const detections = detectClients(env, {
    exists: existsSync,
    onPath: (bin) =>
      (process.env.PATH ?? "")
        .split(delimiter)
        .some((dir) => dir && existsSync(join(dir, bin))),
  }).filter((d) => d.installed);

  process.stdout.write("\nRemoving Stashwise\n\n");
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
  process.stdout.write("\n  Done. Your saved library is untouched.\n\n");
  return 0;
}
