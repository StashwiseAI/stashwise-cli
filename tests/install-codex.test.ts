import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installCodex, uninstallCodex, type CodexRunner } from "../src/codex-mcp.js";

const ARGV = {
  command: "npx",
  args: ["-y", "--prefix", "/Users/x/.stashwise", "--package", "@stashwiseapp/mcp@latest", "stashwise"],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A config with the shape that makes this risky: comments and sub tables. */
const REAL_CONFIG = `# my codex config
model = "gpt-5"

[mcp_servers.codebase-memory-mcp]
command = "/Users/x/.local/bin/codebase-memory-mcp"

[mcp_servers.codebase-memory-mcp.tools.search_code]
enabled = true

# a note I wrote to myself
[mcp_servers.buffer]
url = "https://mcp.buffer.com/mcp"
`;

/** The same config, with our server actually declared in it. */
const CONFIG_WITH_OURS = `${REAL_CONFIG}
[mcp_servers.stashwise]
command = "npx"
args = ["-y", "@stashwiseapp/mcp@0.3.0"]
`;

function scratchConfig(body = REAL_CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), "stashwise-codex-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, body);
  return path;
}

/** A fake codex that records its arguments and can be told how to behave. */
function fakeCodex(options: {
  list?: unknown;
  onAdd?: (path: string) => void;
  configPath?: string;
}): CodexRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run(args) {
      calls.push(args.join(" "));
      if (args[1] === "list") return JSON.stringify(options.list ?? []);
      if (args[1] === "add" && options.onAdd && options.configPath) {
        options.onAdd(options.configPath);
      }
      return "{}";
    },
  };
}

describe("delegating Codex to its own CLI", () => {
  it("adds the server on a clean machine, then confirms Codex accepted it", () => {
    const configPath = scratchConfig();
    const codex = fakeCodex({});
    const result = installCodex(ARGV, { configPath, codex });
    expect(result.status).toBe("installed");
    expect(codex.calls).toEqual([
      "mcp list --json",
      `mcp add stashwise -- ${ARGV.command} ${ARGV.args.join(" ")}`,
      "mcp get stashwise --json",
    ]);
  });

  it("does nothing at all when the entry is already right", () => {
    const configPath = scratchConfig(CONFIG_WITH_OURS);
    const codex = fakeCodex({
      list: [{ name: "stashwise", transport: { command: ARGV.command, args: ARGV.args } }],
    });
    const result = installCodex(ARGV, { configPath, codex });
    expect(result.status).toBe("unchanged");
    expect(codex.calls).toEqual(["mcp list --json"]);
  });

  it("removes before adding when an older entry is there", () => {
    const configPath = scratchConfig(CONFIG_WITH_OURS);
    const codex = fakeCodex({
      list: [{ name: "stashwise", transport: { command: "npx", args: ["-y", "@stashwiseapp/mcp@0.3.0"] } }],
    });
    installCodex(ARGV, { configPath, codex });
    expect(codex.calls[1]).toBe("mcp remove stashwise");
  });

  it("migrates a hosted url entry to the local server", () => {
    const configPath = scratchConfig(CONFIG_WITH_OURS);
    const codex = fakeCodex({
      list: [{ name: "stashwise", transport: { url: "https://oauth.stashwise.co/mcp" } }],
    });
    const result = installCodex(ARGV, { configPath, codex });
    expect(result.status).toBe("installed");
    expect(codex.calls).toContain("mcp remove stashwise");
  });

  it("touches nothing on a dry run", () => {
    const configPath = scratchConfig();
    const before = readFileSync(configPath, "utf8");
    const codex = fakeCodex({});
    installCodex(ARGV, { configPath, codex, dryRun: true });
    expect(codex.calls).toEqual(["mcp list --json"]);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("catches a codex that destroys the rest of the file, and puts it back", () => {
    // The case the invariant exists for. If a future Codex flattens comments or
    // drops another server, we find out here and restore, rather than the user
    // finding out when all their MCP servers stop loading.
    const configPath = scratchConfig();
    const codex = fakeCodex({
      configPath,
      onAdd: (path) => writeFileSync(path, '[mcp_servers.stashwise]\ncommand = "npx"\n'),
    });
    const result = installCodex(ARGV, { configPath, codex });
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("restored") });
    // Everything the user had is back.
    const restored = readFileSync(configPath, "utf8");
    expect(restored).toContain("# a note I wrote to myself");
    expect(restored).toContain("mcp_servers.buffer");
  });

  it("accepts a codex that appends politely", () => {
    const configPath = scratchConfig();
    const codex = fakeCodex({
      configPath,
      onAdd: (path) =>
        writeFileSync(path, `${REAL_CONFIG}\n[mcp_servers.stashwise]\ncommand = "npx"\n`),
    });
    const result = installCodex(ARGV, { configPath, codex });
    expect(result.status).toBe("installed");
    expect(readFileSync(configPath, "utf8")).toContain("# a note I wrote to myself");
  });
});

describe("a server the Codex plugin provides", () => {
  // Found by running this against a real machine. `codex mcp list` includes
  // servers that come from an installed plugin, and those are not in
  // config.toml, cannot be removed by `codex mcp remove`, and must not be
  // duplicated by a second entry of the same name.
  it("is left alone rather than duplicated", () => {
    const configPath = scratchConfig(); // no [mcp_servers.stashwise] block
    const codex = fakeCodex({
      list: [{ name: "stashwise", transport: { url: "https://stashwise-api.fly.dev/mcp/" } }],
    });
    const result = installCodex(ARGV, { configPath, codex });
    expect(result.status).toBe("managed");
    expect(codex.calls).toEqual(["mcp list --json"]);
  });

  it("is not reported as removed by uninstall", () => {
    const configPath = scratchConfig();
    const codex = fakeCodex({
      list: [{ name: "stashwise", transport: { url: "https://stashwise-api.fly.dev/mcp/" } }],
    });
    const result = uninstallCodex({ configPath, codex });
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/plugin/);
  });

  it("uninstall removes what config.toml does declare", () => {
    const configPath = scratchConfig(CONFIG_WITH_OURS);
    const codex = fakeCodex({ list: [{ name: "stashwise", transport: { command: "npx" } }] });
    expect(uninstallCodex({ configPath, codex }).removed).toBe(true);
    expect(codex.calls).toContain("mcp remove stashwise");
  });
});
