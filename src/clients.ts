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
  /** Its own way of registering a remote server. */
  addArgs(url: string): string[];
  listArgs: string[];
  removeArgs: string[];
}

/** No file we can safely write and no CLI, so the honest answer is instructions. */
export interface ManualClientSpec extends BaseSpec {
  kind: "manual";
  configPath(env: PathEnv): string | null;
  instruction: string;
}

export type ClientSpec = JsonClientSpec | CliClientSpec | ManualClientSpec;

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
  // Claude Code, Codex and Gemini each ship an `mcp add` that speaks http, so
  // they register their own server. Delegating means the client validates what
  // it wrote and we never reformat a file it owns: ~/.claude.json alone is
  // 168KB of state a live session rewrites at will.
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    bin: "claude",
    launch: "terminal",
    binaries: ["claude"],
    rootDir: (env) => env.home,
    configPath: (env) => join(env.home, ".claude.json"),
    addArgs: (url) => ["mcp", "add", "--transport", "http", "-s", "user", "stashwise", url],
    listArgs: ["mcp", "list"],
    removeArgs: ["mcp", "remove", "-s", "user", "stashwise"],
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
    addArgs: (url) => ["mcp", "add", "stashwise", "--url", url],
    listArgs: ["mcp", "list", "--json"],
    removeArgs: ["mcp", "remove", "stashwise"],
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
    kind: "cli",
    bin: "gemini",
    launch: "terminal",
    binaries: ["gemini"],
    rootDir: (env) => join(env.home, ".gemini"),
    configPath: (env) => join(env.home, ".gemini", "settings.json"),
    addArgs: (url) => ["mcp", "add", "-s", "user", "-t", "http", "stashwise", url],
    listArgs: ["mcp", "list"],
    removeArgs: ["mcp", "remove", "-s", "user", "stashwise"],
    restartRequired: false,
    verified: true,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    kind: "manual",
    launch: "gui",
    binaries: [],
    rootDir: claudeDesktopDir,
    configPath: (env) => {
      const dir = claudeDesktopDir(env);
      return dir ? join(dir, "claude_desktop_config.json") : null;
    },
    restartRequired: true,
    // Its config file had no mcpServers key at all, and remote connectors are
    // added through the app's own Settings. Writing a key we have never seen it
    // read would be pretending, so this one gets instructions instead.
    verified: false,
    instruction: "Settings, Connectors, Add custom connector, then paste the URL",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    kind: "manual",
    launch: "gui",
    binaries: ["windsurf"],
    rootDir: (env) => join(env.home, ".codeium"),
    configPath: (env) => join(env.home, ".codeium", "windsurf", "mcp_config.json"),
    restartRequired: true,
    verified: false,
    instruction: "add it as a remote MCP server in Windsurf's settings",
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
 * The one address every client is pointed at.
 *
 * Hosted, so there is no local process, no Node requirement, no token on disk
 * and nothing to keep current. It also carries the full tool set, including
 * saving and note taking, which a locally run server does not have.
 *
 * Each client signs in through its own browser approval the first time it
 * connects. That is OAuth, not a choice we made: registration is per client, so
 * no single sign in can cover several of them.
 *
 * The trailing slash is load bearing. The server advertises its resource as
 * `.../mcp/`, and a client compares the address it was handed against that
 * exact string before it will authenticate. Dropping the slash produces
 * "Protected resource does not match expected", which reads like an outage and
 * is really a typo.
 */
export const HOSTED_MCP_URL = "https://oauth.stashwise.co/mcp/";

/** The config entry for one client, in that client's own dialect. */
export function entryFor(spec: ClientSpec, url: string = HOSTED_MCP_URL): Record<string, unknown> {
  // VS Code and Claude Code name the transport; Cursor infers it from `url`.
  if (spec.id === "vscode") return { type: "http", url };
  return { url };
}
