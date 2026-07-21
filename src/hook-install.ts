// `stashwise hook install` / `stashwise hook uninstall` — register the prompt hook in the
// user level Claude Code settings (~/.claude/settings.json) so suggestions
// work in every project on this machine.
//
// The merge/remove logic is pure (operates on a plain settings object) so
// tests never touch the real home directory. File IO lives only in the two
// run* entrypoints. A corrupt settings file is never clobbered: we refuse and
// point at the parse error instead.

import { exec } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STASHWISE_MCP_PACKAGE_SPEC } from "./commands.js";
import { VERSION } from "./version.js";

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

export interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: HookEntry[];
    [event: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

const PACKAGE_NAME = STASHWISE_MCP_PACKAGE_SPEC.replace(/@latest$/, "");
const HOOK_TIMEOUT_SECONDS = 10;

/** A neutral npm project root for the hook's npx invocation.
 *
 * Doubles as the keychain fallback directory, so it already exists on most
 * installs. It must never contain a package.json or node_modules. */
export function npxPrefixDir(): string {
  return join(homedir(), ".stashwise");
}

/** The command written into settings. Pinned to the exact running version so
 * npx resolves from its cache on every prompt instead of hitting the registry;
 * a later `hook install` from a newer version replaces the pin in place.
 *
 * `--prefix` points npm at a directory we control instead of letting it
 * resolve against whatever project the agent is currently in. `npm exec`
 * consults the surrounding project before its own cache, and the hook's cwd is
 * arbitrary, so this removes a variable.
 *
 * Honest scope: this is hardening, not a fix for a reproduced bug. During the
 * 0.4.0 release the pinned command failed to resolve intermittently for about
 * an hour; the failures appeared to correlate with cwd, but that did not hold
 * up under a cold cache and the real cause was never established. What does
 * protect against a repeat is the probe in runHookInstall and the matching
 * doctor check, which turn a silent dead hook into a loud one. */
export function hookCommand(version: string = VERSION): string {
  return `npx -y --prefix ${npxPrefixDir()} --package ${PACKAGE_NAME}@${version} stashwise hook`;
}

/** Recognize our own entry regardless of the pinned version OR the binary name
 * it was written with, so install is idempotent and uninstall finds entries
 * from any prior release.
 *
 * The binary was `mcp` up to 0.3.0 and is `stashwise` from 0.4.0. Matching only
 * the current name would strand every existing install: installHookEntry
 * replaces the first entry it *recognizes*, so an unrecognized old pin means a
 * second entry gets appended beside it and the library is searched twice per
 * prompt, while `hook uninstall` reports success having removed neither. */
const HOOK_INVOCATION_RE = /\b(?:mcp|stashwise) hook\b/;

export function isStashwiseHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    command.includes(PACKAGE_NAME) &&
    HOOK_INVOCATION_RE.test(command)
  );
}

function asEntries(value: unknown): HookEntry[] {
  return Array.isArray(value) ? (value as HookEntry[]) : [];
}

/** Pure merge: add the hook entry, or replace an existing Stashwise entry in
 * place (version bump path). Returns the same object, mutated, plus whether
 * anything changed. All unrelated keys, events, and hooks are preserved. */
export function installHookEntry(
  settings: ClaudeSettings,
  command: string = hookCommand(),
): { settings: ClaudeSettings; changed: boolean } {
  const fresh: HookCommand = {
    type: "command",
    command,
    timeout: HOOK_TIMEOUT_SECONDS,
  };

  if (typeof settings.hooks !== "object" || settings.hooks === null) {
    settings.hooks = {};
  }
  const entries = asEntries(settings.hooks.UserPromptSubmit);
  settings.hooks.UserPromptSubmit = entries;

  for (const entry of entries) {
    if (!Array.isArray(entry.hooks)) continue;
    for (let i = 0; i < entry.hooks.length; i += 1) {
      if (isStashwiseHookCommand(entry.hooks[i]?.command)) {
        if (entry.hooks[i].command === command) {
          return { settings, changed: false };
        }
        entry.hooks[i] = fresh;
        return { settings, changed: true };
      }
    }
  }

  entries.push({ hooks: [fresh] });
  return { settings, changed: true };
}

/** Pure removal: strip every Stashwise hook command, dropping any entry,
 * event array, or hooks object left empty behind it. */
export function removeHookEntry(settings: ClaudeSettings): {
  settings: ClaudeSettings;
  removed: boolean;
} {
  const hooks = settings.hooks;
  if (typeof hooks !== "object" || hooks === null) {
    return { settings, removed: false };
  }
  const entries = asEntries(hooks.UserPromptSubmit);
  let removed = false;

  const kept = entries.filter((entry) => {
    if (!Array.isArray(entry.hooks)) return true;
    const remaining = entry.hooks.filter((h) => {
      const match = isStashwiseHookCommand(h?.command);
      if (match) removed = true;
      return !match;
    });
    entry.hooks = remaining;
    return remaining.length > 0 || Object.keys(entry).some((k) => k !== "hooks");
  });

  if (kept.length > 0) {
    hooks.UserPromptSubmit = kept;
  } else {
    delete hooks.UserPromptSubmit;
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
  return { settings, removed };
}

/** The hook command currently written into user level settings, or null when
 * none is installed. Never throws.
 *
 * `doctor` needs the literal string rather than a boolean because the pin names
 * an exact version, and "a pin exists" is not the same as "that pin resolves".
 * A version that has aged out of the npx cache, or one published so recently
 * that the registry has not propagated it, produces a command that fails while
 * settings still look perfectly correct. */
export function installedHookCommand(): string | null {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    const settings = JSON.parse(raw) as ClaudeSettings;
    for (const entry of asEntries(settings.hooks?.UserPromptSubmit)) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (isStashwiseHookCommand(h?.command)) return String(h.command);
      }
    }
  } catch {
    // Missing or corrupt settings: treat as not installed.
  }
  return null;
}

/** True when the user level settings already carry the hook (any version).
 * Used by `doctor`. Never throws. */
export function hookInstalledInSettings(): boolean {
  return installedHookCommand() !== null;
}

/** Extract the pinned version from a hook command, e.g. "0.4.0". */
export function pinnedVersion(command: string): string | null {
  const m = command.match(/@stashwiseapp\/mcp@([0-9][^\s]*)/);
  return m ? m[1] : null;
}

/** Turn a hook command into one that only prints the version, so `doctor` can
 * prove the pin actually resolves without triggering a library search. */
export function versionProbeFor(command: string): string {
  return command.replace(/\s+hook\b.*$/, " --version");
}

function settingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function loadSettings(path: string): ClaudeSettings | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // No settings file yet: start from empty.
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ClaudeSettings)
      : null;
  } catch {
    return null; // Corrupt: refuse to touch.
  }
}

function saveSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// A cold npx cache genuinely takes tens of seconds on first resolve, so this is
// generous. It is a diagnostic command run by hand, not a hot path.
const PROBE_TIMEOUT_MS = 60_000;

interface ProbeOutcome {
  ok: boolean;
  version: string | null;
  elapsedMs: number;
  detail: string;
}

// The probe runs through a shell deliberately: the harness executes the hook
// command through a shell too, so anything else would verify something other
// than what actually happens at prompt time. Splitting the string into argv for
// execFile would diverge from the real invocation and defeat the purpose.
//
// The string comes from the user's own settings.json, and anyone who can write
// there already has command execution on every prompt via the hook itself, so
// running it here grants no new capability. It is still validated against the
// exact shape we write, so a hand-edited or tampered entry is reported rather
// than executed. `versionProbeFor` also truncates everything after the `hook`
// token, which strips any trailing suffix on its own.
const SAFE_PROBE_RE =
  /^npx\s+(?:-y\s+|--yes\s+)?(?:--prefix(?:=|\s+)\S+\s+)?--package(?:=|\s+)@stashwiseapp\/mcp@[\w.-]+\s+(?:mcp|stashwise)\s+--version$/;

export function isProbeSafe(probe: string): boolean {
  return SAFE_PROBE_RE.test(probe.trim());
}

/** Run the pinned command with `--version` and report whether it worked. */
export function probeHookCommand(command: string): Promise<ProbeOutcome> {
  const started = Date.now();
  if (!isProbeSafe(command)) {
    return Promise.resolve({
      ok: false,
      version: null,
      elapsedMs: 0,
      detail:
        "the installed command does not match the expected form, so it was not run. Inspect ~/.claude/settings.json",
    });
  }
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const elapsedMs = Date.now() - started;
        const version = (stdout || "").trim().match(/^\d+\.\d+\.\d+\S*/)?.[0] ?? null;
        if (version) {
          resolve({ ok: true, version, elapsedMs, detail: "ok" });
          return;
        }
        // `command not found` surfaces on stderr with a non-zero exit; a
        // timeout arrives with err.killed set and no useful output.
        const reason = (err as { killed?: boolean } | null)?.killed
          ? `no response in ${PROBE_TIMEOUT_MS / 1000}s`
          : ((stderr || "").trim().split("\n")[0] ||
             (err instanceof Error ? err.message.split("\n")[0] : "no version on stdout"));
        resolve({ ok: false, version: null, elapsedMs, detail: reason });
      },
    );
  });
}


export async function runHookInstall(): Promise<number> {
  const path = settingsPath();
  const settings = loadSettings(path);
  if (settings === null) {
    process.stderr.write(
      `Refusing to modify ${path}: the file is not valid JSON. Fix it manually, then rerun.\n`,
    );
    return 1;
  }

  // The prefix directory must exist before npx is pointed at it.
  try {
    mkdirSync(npxPrefixDir(), { recursive: true });
  } catch {
    // Best effort; the probe below reports it if this mattered.
  }

  const { changed } = installHookEntry(settings);
  if (!changed) {
    process.stdout.write(
      `Stashwise prompt hook is already installed in ${path}.\n`,
    );
    return 0;
  }

  saveSettings(path, settings);
  process.stdout.write(
    [
      `Stashwise prompt hook installed in ${path}.`,
      "Claude Code will now check your Stashwise library on each prompt and surface strong matches as context.",
      "Remove it any time with: stashwise hook uninstall",
      "",
      "Verifying the pinned command resolves…",
    ].join("\n") + "\n",
  );

  // Never report success for a hook that cannot start. Writing a pin is not
  // the same as writing a pin that works: a version still propagating through
  // the registry, or a first-time npx cache entry that fails to build, both
  // yield a command that exits 0 with no output — which the harness cannot
  // distinguish from "nothing matched". Prove it here, while the user is
  // watching, rather than leaving them to discover silence weeks later.
  const outcome = await probeHookCommand(versionProbeFor(hookCommand()));
  if (outcome.ok) {
    process.stdout.write(`  ok — ${outcome.version} in ${outcome.elapsedMs}ms\n`);
    return 0;
  }
  process.stderr.write(
    [
      `  FAILED — ${outcome.detail}`,
      "",
      "  The hook is written to settings but will not run, and it fails",
      "  silently, so you would see no suggestions and no error.",
      "  If this package was published moments ago, wait a minute and rerun",
      "  `stashwise hook install`. Otherwise run `stashwise doctor`.",
      "",
    ].join("\n"),
  );
  return 1;
}

export async function runHookUninstall(): Promise<number> {
  const path = settingsPath();
  const settings = loadSettings(path);
  if (settings === null) {
    process.stderr.write(
      `Refusing to modify ${path}: the file is not valid JSON. Fix it manually, then rerun.\n`,
    );
    return 1;
  }

  const { removed } = removeHookEntry(settings);
  if (!removed) {
    process.stdout.write(`No Stashwise prompt hook found in ${path}.\n`);
    return 0;
  }

  saveSettings(path, settings);
  process.stdout.write(`Stashwise prompt hook removed from ${path}.\n`);
  return 0;
}
