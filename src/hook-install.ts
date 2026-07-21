// `mcp hook install` / `mcp hook uninstall` — register the prompt hook in the
// user level Claude Code settings (~/.claude/settings.json) so suggestions
// work in every project on this machine.
//
// The merge/remove logic is pure (operates on a plain settings object) so
// tests never touch the real home directory. File IO lives only in the two
// run* entrypoints. A corrupt settings file is never clobbered: we refuse and
// point at the parse error instead.

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

/** The command written into settings. Pinned to the exact running version so
 * npx resolves from its cache on every prompt instead of hitting the registry;
 * a later `hook install` from a newer version replaces the pin in place. */
export function hookCommand(version: string = VERSION): string {
  return `npx -y --package ${PACKAGE_NAME}@${version} mcp hook`;
}

/** Recognize our own entry regardless of the pinned version, so install is
 * idempotent and uninstall finds entries written by any prior version. */
export function isStashwiseHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    command.includes(PACKAGE_NAME) &&
    /\bmcp hook\b/.test(command)
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

/** True when the user level settings already carry the hook (any version).
 * Used by `doctor`. Never throws. */
export function hookInstalledInSettings(): boolean {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    const settings = JSON.parse(raw) as ClaudeSettings;
    return asEntries(settings.hooks?.UserPromptSubmit).some(
      (entry) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => isStashwiseHookCommand(h?.command)),
    );
  } catch {
    return false;
  }
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

export async function runHookInstall(): Promise<number> {
  const path = settingsPath();
  const settings = loadSettings(path);
  if (settings === null) {
    process.stderr.write(
      `Refusing to modify ${path}: the file is not valid JSON. Fix it manually, then rerun.\n`,
    );
    return 1;
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
      "The first prompt after install may be slow while npx warms its cache.",
      "Remove it any time with: mcp hook uninstall",
      "",
    ].join("\n"),
  );
  return 0;
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
