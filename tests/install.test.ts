import { describe, expect, it } from "vitest";
import {
  CANONICAL_KEY,
  installServerEntry,
  isStashwiseServerEntry,
  removeServerEntry,
} from "../src/mcp-config.js";
import { CLIENTS, detectClients, entryFor, guiPath, type PathEnv } from "../src/clients.js";
import { renderSummary, type ClientResult } from "../src/install.js";
import { classifyJson } from "../src/config-file.js";

const ENV: PathEnv = { home: "/Users/x", platform: "darwin" };

function probe(paths: string[] = [], bins: string[] = []) {
  return {
    exists: (p: string) => paths.includes(p),
    onPath: (b: string) => bins.includes(b),
  };
}

describe("recognising entries we have written before", () => {
  // Every shape Stashwise has been configured as, across four releases. Missing
  // one means install appends beside it and the client ends up with two
  // Stashwise servers, the stale one still running.
  const ours: Array<[string, unknown, string]> = [
    ["bare npx", { command: "npx", args: ["-y", "@stashwiseapp/mcp@latest"] }, "stashwise"],
    [
      "pinned, old binary name",
      { command: "npx", args: ["-y", "--package", "@stashwiseapp/mcp@0.3.0", "mcp"] },
      "stashwise",
    ],
    ["installed globally", { command: "stashwise" }, "stashwise"],
    ["hosted, platform host", { type: "http", url: "https://stashwise-api.fly.dev/mcp/" }, "stashwise"],
    ["hosted, branded host", { type: "http", url: "https://oauth.stashwise.co/mcp" }, "stashwise"],
    ["renamed by hand", { command: "stashwise" }, "stashwise-local"],
  ];
  for (const [name, entry, key] of ours) {
    it(`recognises ${name}`, () => {
      expect(isStashwiseServerEntry(entry, key)).toBe(true);
    });
  }

  const theirs: Array<[string, unknown, string]> = [
    ["another mcp package", { command: "npx", args: ["-y", "mcp-jira-cloud"] }, "jira"],
    ["a local binary", { command: "/Users/x/.local/bin/codebase-memory-mcp" }, "memory"],
    ["someone else's url", { type: "http", url: "https://mcp.buffer.com/mcp" }, "buffer"],
    ["a stashwise.co url that is not the server", { url: "https://stashwise.co/library" }, "x"],
  ];
  for (const [name, entry, key] of theirs) {
    it(`leaves ${name} alone`, () => {
      expect(isStashwiseServerEntry(entry, key)).toBe(false);
    });
  }

  it("will not claim a bare `mcp` binary outside a Stashwise key", () => {
    // `mcp` is far too generic a name to adopt on sight. Under our own key it
    // is the pre-0.4.0 binary; under someone else's it is someone else's.
    expect(isStashwiseServerEntry({ command: "mcp" }, "stashwise")).toBe(true);
    expect(isStashwiseServerEntry({ command: "mcp" }, "other-tool")).toBe(false);
  });
});

describe("merging into a config", () => {
  // A realistic entry: it has to carry the package spec, or the recogniser
  // rightly refuses to treat it as ours.
  const entry = {
    type: "stdio",
    command: "npx",
    args: ["-y", "--prefix", "/Users/x/.stashwise", "--package", "@stashwiseapp/mcp@latest", "stashwise"],
  };

  it("creates the container and the entry in an empty config", () => {
    const result = installServerEntry({}, "mcpServers", entry);
    expect(result.action).toBe("created");
    expect(result.doc).toEqual({ mcpServers: { stashwise: entry } });
  });

  it("does not write when the entry is already exactly right", () => {
    const doc = { mcpServers: { stashwise: entry } };
    const result = installServerEntry(doc, "mcpServers", entry);
    expect(result.action).toBe("unchanged");
    expect(result.changed).toBe(false);
  });

  it("replaces an older entry in place, keeping its position", () => {
    const doc = {
      mcpServers: {
        jira: { command: "npx", args: ["-y", "mcp-jira-cloud"] },
        stashwise: { command: "npx", args: ["-y", "--package", "@stashwiseapp/mcp@0.3.0", "mcp"] },
        memory: { command: "/usr/local/bin/memory" },
      },
    };
    const before = Object.keys(doc.mcpServers);
    const result = installServerEntry(doc, "mcpServers", entry);
    expect(result.action).toBe("replaced");
    // Position matters: reordering the file turns one line of diff into many.
    expect(Object.keys(result.doc.mcpServers as object)).toEqual(before);
    expect((result.doc.mcpServers as Record<string, unknown>).stashwise).toEqual(entry);
  });

  it("collapses duplicates left by the hosted experiment", () => {
    const doc = {
      mcpServers: {
        stashwise: { command: "npx", args: ["-y", "--package", "@stashwiseapp/mcp@0.3.0", "mcp"] },
        "stashwise-local": { type: "http", url: "https://oauth.stashwise.co/mcp" },
      },
    };
    const result = installServerEntry(doc, "mcpServers", entry);
    expect(result.removedKeys).toEqual(["stashwise-local"]);
    expect(Object.keys(result.doc.mcpServers as object)).toEqual(["stashwise"]);
  });

  it("refuses to evict a stranger squatting on our name", () => {
    const doc = { mcpServers: { stashwise: { command: "someone-elses-server" } } };
    const result = installServerEntry(doc, "mcpServers", entry);
    expect(result.action).toBe("refused");
    expect(result.changed).toBe(false);
    expect(doc.mcpServers.stashwise).toEqual({ command: "someone-elses-server" });
  });

  it("leaves every other server byte identical", () => {
    // Lifted from a real machine: six servers, five of them nothing to do with us.
    const others = {
      jira: { command: "npx", args: ["-y", "mcp-jira"], env: { TOKEN: "secret" }, type: "stdio" },
      composio: { type: "http", url: "https://apollo.composio.dev/mcp" },
      "palmier-pro": { type: "http", url: "https://mcp.palmier.io/mcp" },
      higgsfield: { type: "http", url: "https://higgsfield.ai/mcp" },
      "codebase-memory-mcp": { command: "/Users/x/.local/bin/codebase-memory-mcp" },
    };
    const doc = { mcpServers: { ...others, stashwise: { command: "stashwise" } } };
    const snapshot = JSON.stringify(others);
    installServerEntry(doc, "mcpServers", entry);
    const after = { ...doc.mcpServers } as Record<string, unknown>;
    delete after.stashwise;
    expect(JSON.stringify(after)).toBe(snapshot);
  });

  it("works the same for VS Code's differently named container", () => {
    const result = installServerEntry({}, "servers", entry);
    expect(result.doc).toEqual({ servers: { stashwise: entry } });
  });

  it("refuses when the container is not an object", () => {
    const result = installServerEntry({ mcpServers: [1, 2] }, "mcpServers", entry);
    expect(result.action).toBe("refused");
  });
});

describe("removing", () => {
  it("takes every shape of ours and leaves the rest", () => {
    const doc = {
      mcpServers: {
        stashwise: { command: "stashwise" },
        "stashwise-local": { url: "https://oauth.stashwise.co/mcp" },
        jira: { command: "npx", args: ["-y", "mcp-jira"] },
      },
    };
    const { removedKeys } = removeServerEntry(doc, "mcpServers");
    expect(removedKeys.sort()).toEqual(["stashwise", "stashwise-local"]);
    expect(Object.keys(doc.mcpServers)).toEqual(["jira"]);
  });

  it("drops a container it emptied, leaving no residue", () => {
    const doc: Record<string, unknown> = { mcpServers: { stashwise: { command: "stashwise" } } };
    removeServerEntry(doc, "mcpServers");
    expect(doc.mcpServers).toBeUndefined();
  });

  it("reports nothing removed from an untouched config", () => {
    expect(removeServerEntry({}, "mcpServers").removedKeys).toEqual([]);
  });
});

describe("detecting what is installed", () => {
  it("finds nothing on a bare machine", () => {
    const found = detectClients(ENV, probe()).filter((d) => d.installed);
    expect(found).toEqual([]);
  });

  it("does not mistake the home directory for a client", () => {
    // Claude Code's root is $HOME, which always exists. Only its config or its
    // binary may count, or install would claim it on every machine alive.
    const found = detectClients(ENV, probe([])).find((d) => d.spec.id === "claude-code");
    expect(found?.installed).toBe(false);
  });

  it("counts a binary on PATH", () => {
    const found = detectClients(ENV, probe([], ["codex"])).find((d) => d.spec.id === "codex");
    expect(found?.installed).toBe(true);
  });

  it("counts a config file that exists", () => {
    const found = detectClients(ENV, probe(["/Users/x/.cursor/mcp.json"])).find(
      (d) => d.spec.id === "cursor",
    );
    expect(found?.installed).toBe(true);
  });

  it("counts a root directory even with no config yet", () => {
    const found = detectClients(ENV, probe(["/Users/x/.gemini"])).find(
      (d) => d.spec.id === "gemini-cli",
    );
    expect(found?.installed).toBe(true);
  });

  it("puts VS Code's config where VS Code keeps it", () => {
    const vscode = detectClients(ENV, probe()).find((d) => d.spec.id === "vscode");
    expect(vscode?.configPath).toBe("/Users/x/Library/Application Support/Code/User/mcp.json");
  });

  it("gives Windows its own paths", () => {
    const win: PathEnv = { home: "C:\\Users\\x", platform: "win32", appData: "C:\\Users\\x\\AppData\\Roaming" };
    const vscode = detectClients(win, probe()).find((d) => d.spec.id === "vscode");
    expect(vscode?.configPath).toContain("AppData");
  });
});

describe("the entry each client gets", () => {
  it("gives GUI clients a PATH they can actually use", () => {
    // An app launched from the Dock has no shell PATH, so a bare `npx` is not
    // resolvable. This is the difference between working and silently not.
    const cursor = CLIENTS.find((c) => c.id === "cursor")!;
    const entry = entryFor(cursor, "/Users/x/.stashwise", "/opt/node/bin/node");
    expect((entry.env as Record<string, string>).PATH).toContain("/opt/node/bin");
  });

  it("leaves terminal clients their own PATH", () => {
    const claude = CLIENTS.find((c) => c.id === "claude-code")!;
    const entry = entryFor(claude, "/Users/x/.stashwise", "/opt/node/bin/node");
    expect(entry.env).toBeUndefined();
  });

  it("keeps --prefix, which is load bearing", () => {
    const claude = CLIENTS.find((c) => c.id === "claude-code")!;
    const entry = entryFor(claude, "/Users/x/.stashwise", "/opt/node/bin/node");
    expect(entry.args).toContain("--prefix");
  });

  it("tracks @latest so a rerun is the upgrade path", () => {
    const claude = CLIENTS.find((c) => c.id === "claude-code")!;
    expect((entry(claude) as string[]).join(" ")).toContain("@stashwiseapp/mcp@latest");
    function entry(spec: typeof claude) {
      return entryFor(spec, "/p", "/n").args;
    }
  });

  it("builds a PATH without leaking the caller's own", () => {
    expect(guiPath("/opt/node/bin/node")).not.toContain("/Users/x/some/project");
    expect(guiPath("/opt/node/bin/node").split(":")[0]).toBe("/opt/node/bin");
  });
});

describe("classifying a config file", () => {
  it("accepts strict JSON objects", () => {
    expect(classifyJson('{"a":1}').kind).toBe("json");
  });

  it("calls a commented config JSONC, not corrupt", () => {
    // Refusing this as "not valid JSON" blames the user for a file that is
    // fine, and stripping the comments silently rewrites their work.
    expect(classifyJson('{\n // mine\n "a": 1\n}').kind).toBe("jsonc");
    expect(classifyJson("{\n /* mine */ \"a\": 1\n}").kind).toBe("jsonc");
  });

  it("calls a trailing comma JSONC", () => {
    expect(classifyJson('{"a": 1,}').kind).toBe("jsonc");
  });

  it("is not fooled by comment characters inside a string", () => {
    const raw = '{"url": "https://x.co//path", "note": "/* not a comment */"}';
    expect(classifyJson(raw).kind).toBe("json");
  });

  it("refuses arrays and scalars, which cannot hold a container", () => {
    expect(classifyJson("[1,2,3]").kind).toBe("not-object");
    expect(classifyJson('"hello"').kind).toBe("not-object");
    expect(classifyJson("null").kind).toBe("not-object");
  });

  it("reports genuine corruption with the parser's own words", () => {
    const result = classifyJson("{oh no");
    expect(result.kind).toBe("corrupt");
    expect(result.error).toBeTruthy();
  });
});

describe("a tool that is installed but never configured", () => {
  // Found by running the published package as a new user. Gemini CLI was on
  // PATH with no ~/.gemini directory: the dry run said "installed" and the real
  // run failed with "that client is not installed", which cannot both be true.
  // Detection is the gate; a missing config directory for a tool we found is
  // the ordinary case of someone who has never configured MCP in it.
  it("is detected from its binary alone", () => {
    const found = detectClients(ENV, probe([], ["gemini"])).find(
      (d) => d.spec.id === "gemini-cli",
    );
    expect(found?.installed).toBe(true);
    expect(found?.configPath).toBe("/Users/x/.gemini/settings.json");
  });
});

describe("a dry run has to look like one", () => {
  // Three bugs came from asking each code path to remember to say "dry run":
  // the Codex row reported a plain "installed" beside rows that admitted they
  // were hypothetical, and uninstall's preview was byte identical to the real
  // thing. A dry run's only product is its output, so an unmarked row is not a
  // cosmetic slip, it is the entire failure. One place decides now, and this
  // holds it there.
  const results: ClientResult[] = [
    { id: "claude-code", label: "Claude Code", status: "installed", restartRequired: false },
    { id: "cursor", label: "Cursor", status: "updated", restartRequired: true },
    { id: "codex", label: "Codex CLI", status: "installed", restartRequired: false },
    { id: "vscode", label: "VS Code", status: "absent", restartRequired: true },
    { id: "gemini-cli", label: "Gemini CLI", status: "unchanged", restartRequired: false },
  ];

  it("marks every row that claims a change, whichever writer produced it", () => {
    const out = renderSummary(results, true);
    for (const line of out.split("\n")) {
      if (/installed|updated/.test(line)) {
        expect(line, `unmarked: ${line}`).toContain("dry run");
      }
    }
  });

  it("does not mark rows that changed nothing", () => {
    const out = renderSummary(results, true).split("\n");
    expect(out.find((l) => l.includes("absent"))).not.toContain("dry run");
    expect(out.find((l) => l.includes("unchanged"))).not.toContain("dry run");
  });

  it("says nothing about restarting, since nothing was written", () => {
    expect(renderSummary(results, true)).not.toContain("Restart");
    expect(renderSummary(results, false)).toContain("Restart Cursor");
  });

  it("leaves a real run unmarked", () => {
    expect(renderSummary(results, false)).not.toContain("dry run");
  });

  it("keeps a writer's own detail alongside the marker", () => {
    const withDetail: ClientResult[] = [
      { id: "cursor", label: "Cursor", status: "updated", detail: "replaced 2 entries", restartRequired: true },
    ];
    const line = renderSummary(withDetail, true);
    expect(line).toContain("replaced 2 entries");
    expect(line).toContain("dry run");
  });
});
