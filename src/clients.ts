// Which AI tools we know how to configure, and how to tell they are installed.
//
// Pure data plus pure detection. `detectClients` takes a probe rather than
// touching the filesystem, so the whole table is testable against a set of fake
// paths.
//
// Two things here were discovered by reading a real machine rather than docs,
// and both would have shipped as silent failures:
//
//   VS Code's container key is `servers`, not `mcpServers`. Writing the latter
//   produces a valid file that VS Code ignores completely.
//
//   GUI applications do not inherit a shell PATH. On the machine this was
//   written on, npx lives in ~/.local/bin, which launchd knows nothing about,
//   so `"command": "npx"` resolves for Claude Code in a terminal and fails for
//   Cursor launched from the Dock. Those clients get an explicit PATH.

import { delimiter, dirname, join } from "node:path";

/** Where the client is started from, which decides whether it has a shell PATH. */
export type LaunchContext = "gui" | "terminal";

export interface PathEnv {
  home: string;
  platform: NodeJS.Platform;
  /** %APPDATA% on Windows. */
  appData?: string;
}

interface BaseSpec {
  id: ClientId;
  label: string;
  launch: LaunchContext;
  /**
   * Its presence proves the client is installed, and we never create it. An
   * absent root is how we know not to litter a config into a machine that has
   * never run this tool.
   */
  rootDir(env: PathEnv): string | null;
  /** Any one of these on PATH also proves it. */
  binaries: string[];
  restartRequired: boolean;
  /** Whether the config shape below was checked against a real installation. */
  verified: boolean;
  note?: string;
}

export interface JsonClientSpec extends BaseSpec {
  kind: "json";
  configPath(env: PathEnv): string | null;
  /** VS Code says `servers`. Everyone else says `mcpServers`. */
  containerKey: string;
}

export interface CliClientSpec extends BaseSpec {
  kind: "cli";
  /** The client owns its own config writer, so we drive that instead. */
  bin: string;
  configPath(env: PathEnv): string | null;
}

export type ClientSpec = JsonClientSpec | CliClientSpec;

export type ClientId =
  | "claude-code"
  | "cursor"
  | "codex"
  | "vscode"
  | "gemini-cli"
  | "claude-desktop"
  | "windsurf";

function vscodeUserDir(env: PathEnv): string | null {
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "Code", "User");
  }
  if (env.platform === "win32") {
    return env.appData ? join(env.appData, "Code", "User") : null;
  }
  return join(env.home, ".config", "Code", "User");
}

function claudeDesktopDir(env: PathEnv): string | null {
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "Claude");
  }
  if (env.platform === "win32") {
    return env.appData ? join(env.appData, "Claude") : null;
  }
  return join(env.home, ".config", "Claude");
}

export const CLIENTS: ClientSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "json",
    launch: "terminal",
    binaries: ["claude"],
    rootDir: (env) => env.home,
    configPath: (env) => join(env.home, ".claude.json"),
    containerKey: "mcpServers",
    restartRequired: false,
    verified: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "json",
    launch: "gui",
    binaries: ["cursor"],
    rootDir: (env) => join(env.home, ".cursor"),
    configPath: (env) => join(env.home, ".cursor", "mcp.json"),
    containerKey: "mcpServers",
    restartRequired: true,
    verified: true,
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "cli",
    bin: "codex",
    launch: "terminal",
    binaries: ["codex"],
    rootDir: (env) => join(env.home, ".codex"),
    configPath: (env) => join(env.home, ".codex", "config.toml"),
    restartRequired: false,
    verified: true,
  },
  {
    id: "vscode",
    label: "VS Code",
    kind: "json",
    launch: "gui",
    binaries: ["code"],
    rootDir: vscodeUserDir,
    configPath: (env) => {
      const dir = vscodeUserDir(env);
      return dir ? join(dir, "mcp.json") : null;
    },
    // Not `mcpServers`. Verified against a real installation.
    containerKey: "servers",
    restartRequired: true,
    verified: true,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    kind: "json",
    launch: "terminal",
    binaries: ["gemini"],
    rootDir: (env) => join(env.home, ".gemini"),
    configPath: (env) => join(env.home, ".gemini", "settings.json"),
    containerKey: "mcpServers",
    restartRequired: false,
    verified: true,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    kind: "json",
    launch: "gui",
    binaries: [],
    rootDir: claudeDesktopDir,
    configPath: (env) => {
      const dir = claudeDesktopDir(env);
      return dir ? join(dir, "claude_desktop_config.json") : null;
    },
    containerKey: "mcpServers",
    restartRequired: true,
    // The installation checked had no mcpServers key at all: recent versions
    // appear to manage connectors through Settings instead. Writing the key is
    // additive and harmless, but we do not claim to have proven it is read.
    verified: false,
    note: "check Settings, Developer if it does not appear",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    kind: "json",
    launch: "gui",
    binaries: ["windsurf"],
    rootDir: (env) => join(env.home, ".codeium"),
    configPath: (env) => join(env.home, ".codeium", "windsurf", "mcp_config.json"),
    containerKey: "mcpServers",
    restartRequired: true,
    verified: false,
  },
];

export interface DetectProbe {
  exists(path: string): boolean;
  onPath(bin: string): boolean;
}

export interface Detection {
  spec: ClientSpec;
  installed: boolean;
  configPath: string | null;
  rootDir: string | null;
}

export function detectClients(
  env: PathEnv,
  probe: DetectProbe,
  specs: ClientSpec[] = CLIENTS,
): Detection[] {
  return specs.map((spec) => {
    const configPath = spec.configPath(env);
    const rootDir = spec.rootDir(env);
    const installed =
      (configPath !== null && probe.exists(configPath)) ||
      (rootDir !== null && rootDir !== env.home && probe.exists(rootDir)) ||
      spec.binaries.some((bin) => probe.onPath(bin));
    return { spec, installed, configPath, rootDir };
  });
}

/**
 * A PATH a GUI application can actually use.
 *
 * Not the caller's own PATH, which carries project directories and is long.
 * The directory node is running from, plus the standard locations, which is
 * what makes `npx` resolvable from an app launched by the window manager.
 */
export function guiPath(execPath: string): string {
  return [
    dirname(execPath),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(delimiter);
}

/**
 * The argv every client is pointed at.
 *
 * `@latest` rather than a pinned version, deliberately diverging from
 * `hookCommand()`. The hook re-resolves on every prompt and is repinned by a
 * later `hook install`, so a pin there is cheap and precise. An MCP entry is
 * written once and never looked at again, so pinning would strand people on
 * whatever version installed them, with no upgrade path short of editing the
 * file by hand. Rerunning install is the upgrade path, and the merge above is
 * idempotent so that is safe.
 *
 * `--prefix` is kept for the reason set out at length in hook-install.ts:
 * `npm exec --package X@V` fails when the working directory is X at version V,
 * which is exactly the situation of the person developing this package.
 */
export function serverArgv(prefixDir: string): { command: string; args: string[] } {
  return {
    command: "npx",
    args: ["-y", "--prefix", prefixDir, "--package", "@stashwiseapp/mcp@latest", "stashwise"],
  };
}

/** The config entry for one client, in that client's own dialect. */
export function entryFor(
  spec: ClientSpec,
  prefixDir: string,
  execPath: string,
): Record<string, unknown> {
  const { command, args } = serverArgv(prefixDir);
  const entry: Record<string, unknown> = { command, args };
  // Claude Code and VS Code both record a transport type; the others infer it.
  if (spec.id === "claude-code" || spec.id === "vscode") entry.type = "stdio";
  // Without this, a client launched from the Dock cannot find npx at all.
  if (spec.launch === "gui") entry.env = { PATH: guiPath(execPath) };
  return entry;
}
