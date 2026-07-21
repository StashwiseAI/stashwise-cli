import { describe, expect, it } from "vitest";
import type { AgentSearchResultItem } from "../src/api.js";
import {
  filterSuggestions,
  formatSuggestions,
  parseHookArgs,
  parseHookPayload,
  requiredScore,
  shouldQuery,
} from "../src/hook.js";
import {
  hookCommand,
  installHookEntry,
  isStashwiseHookCommand,
  removeHookEntry,
  type ClaudeSettings,
} from "../src/hook-install.js";

function item(overrides: Partial<AgentSearchResultItem> = {}): AgentSearchResultItem {
  return {
    kind: "content",
    id: "id-1",
    title: "Orca",
    snippet: "Open source IDE that runs parallel Claude Code agents in isolated worktrees.",
    source_url: "https://example.com/orca",
    source_platform: "instagram",
    score: 0.6,
    citation: "Orca — example.com",
    saved_at: "2026-07-21T01:51:17.176524",
    ...overrides,
  };
}

describe("parseHookPayload", () => {
  it("accepts a valid UserPromptSubmit payload", () => {
    const raw = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "abc123",
      prompt: "how do I run parallel agents",
    });
    expect(parseHookPayload(raw)).toEqual({
      sessionId: "abc123",
      prompt: "how do I run parallel agents",
    });
  });

  it("defaults sessionId when session_id is missing", () => {
    const raw = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "a real prompt here",
    });
    expect(parseHookPayload(raw)?.sessionId).toBe("unknown");
  });

  it("rejects garbage JSON", () => {
    expect(parseHookPayload("not json at all")).toBeNull();
  });

  it("rejects non object payloads", () => {
    expect(parseHookPayload('"just a string"')).toBeNull();
    expect(parseHookPayload("null")).toBeNull();
  });

  it("rejects other hook events", () => {
    const raw = JSON.stringify({
      hook_event_name: "PreToolUse",
      prompt: "still has a prompt",
    });
    expect(parseHookPayload(raw)).toBeNull();
  });

  it("rejects a missing or blank prompt", () => {
    expect(
      parseHookPayload(JSON.stringify({ hook_event_name: "UserPromptSubmit" })),
    ).toBeNull();
    expect(
      parseHookPayload(
        JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "   " }),
      ),
    ).toBeNull();
  });
});

describe("shouldQuery", () => {
  it("accepts a normal question", () => {
    expect(shouldQuery("how do I run parallel claude code agents")).toBe(true);
  });

  it("rejects short prompts", () => {
    expect(shouldQuery("fix this")).toBe(false);
  });

  it("rejects slash commands, bang lines, and memory shortcuts", () => {
    expect(shouldQuery("/model switch to opus please")).toBe(false);
    expect(shouldQuery("!git status --short please")).toBe(false);
    expect(shouldQuery("# remember this preference forever")).toBe(false);
  });

  it("ignores leading whitespace when checking the first character", () => {
    expect(shouldQuery("   /help me with something long")).toBe(false);
  });
});

describe("filterSuggestions", () => {
  it("keeps scores at or above the threshold and drops the rest", () => {
    const results = [
      item({ id: "a", score: 0.5 }),
      item({ id: "b", score: 0.35 }),
      item({ id: "c", score: 0.349 }),
    ];
    const kept = filterSuggestions(results, 0.35, new Set());
    expect(kept.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("excludes ids already suggested this session", () => {
    const results = [item({ id: "a" }), item({ id: "b" })];
    const kept = filterSuggestions(results, 0.35, new Set(["a"]));
    expect(kept.map((r) => r.id)).toEqual(["b"]);
  });

  it("caps at three suggestions", () => {
    const results = ["a", "b", "c", "d", "e"].map((id) => item({ id }));
    expect(filterSuggestions(results, 0.35, new Set())).toHaveLength(3);
  });

  it("returns empty for empty input", () => {
    expect(filterSuggestions([], 0.35, new Set())).toEqual([]);
  });

  it("drops results whose snippet is empty or too short to inform", () => {
    const results = [
      item({ id: "bare", snippet: "" }),
      item({ id: "stub", snippet: "Too short." }),
      item({ id: "real" }),
    ];
    const kept = filterSuggestions(results, 0.45, new Set());
    expect(kept.map((r) => r.id)).toEqual(["real"]);
  });

  it("holds wiki entities to a higher bar than saved content", () => {
    // 0.57 is the live score of the generic "TypeScript" entity against
    // "fix this typescript type error": above the content floor, below the
    // entity bar.
    const results = [
      item({ id: "entity-mid", kind: "entity", score: 0.57, source_url: null }),
      item({ id: "content-mid", kind: "content", score: 0.57 }),
    ];
    const kept = filterSuggestions(results, 0.45, new Set());
    expect(kept.map((r) => r.id)).toEqual(["content-mid"]);
  });

  it("still admits a strongly matching entity", () => {
    // The Ahrefs entity scored 0.68 when the prompt was actually about it.
    const results = [
      item({ id: "entity-strong", kind: "entity", score: 0.68, source_url: null }),
    ];
    expect(filterSuggestions(results, 0.45, new Set())).toHaveLength(1);
  });
});

describe("requiredScore", () => {
  it("uses the plain floor for content and a margin for entities", () => {
    expect(requiredScore("content", 0.45)).toBeCloseTo(0.45);
    expect(requiredScore("entity", 0.45)).toBeCloseTo(0.6);
  });

  it("tracks a custom floor", () => {
    expect(requiredScore("content", 0.5)).toBeCloseTo(0.5);
    expect(requiredScore("entity", 0.5)).toBeCloseTo(0.65);
  });
});

describe("formatSuggestions", () => {
  it("renders the wrapper, numbering, metadata, and URL", () => {
    const block = formatSuggestions([item()]);
    expect(block.startsWith("<stashwise-suggestions>")).toBe(true);
    expect(block.endsWith("</stashwise-suggestions>")).toBe(true);
    expect(block).toContain("1. Orca (instagram, saved 2026-07-21):");
    expect(block).toContain("   https://example.com/orca");
  });

  it("states a binding citation requirement and an explicit silent branch", () => {
    const block = formatSuggestions([item()]);
    expect(block).toContain("REQUIRED:");
    expect(block).toMatch(/cite it inline/);
    expect(block).toMatch(/If none apply/);
    // Soft phrasing lost to competing context in a real session; guard it.
    expect(block).not.toMatch(/only if genuinely relevant/);
  });

  it("truncates long snippets", () => {
    const block = formatSuggestions([item({ snippet: "x".repeat(500) })]);
    const line = block.split("\n").find((l) => l.startsWith("1."));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(250);
    expect(line).toContain("…");
  });

  it("omits metadata parens and URL line when absent", () => {
    const block = formatSuggestions([
      item({ source_platform: null, saved_at: null, source_url: null }),
    ]);
    expect(block).toContain("1. Orca:");
    expect(block).not.toContain("(");
    expect(block).not.toContain("https://");
  });
});

describe("parseHookArgs", () => {
  it("returns defaults with no args", () => {
    expect(parseHookArgs([])).toEqual({ minScore: 0.45, k: 6, timeoutMs: 2500 });
  });

  it("parses inline and space separated flags", () => {
    expect(parseHookArgs(["--min-score=0.5", "--k", "3", "--timeout-ms=1000"])).toEqual({
      minScore: 0.5,
      k: 3,
      timeoutMs: 1000,
    });
  });

  it("flags out of range values", () => {
    expect(parseHookArgs(["--min-score", "2"]).error).toMatch(/--min-score/);
    expect(parseHookArgs(["--k", "0"]).error).toMatch(/--k/);
    expect(parseHookArgs(["--timeout-ms", "50"]).error).toMatch(/--timeout-ms/);
  });

  it("ignores unknown flags", () => {
    expect(parseHookArgs(["--future-flag", "x"]).error).toBeUndefined();
  });
});

describe("isStashwiseHookCommand", () => {
  it("matches any pinned version of the hook command", () => {
    expect(isStashwiseHookCommand(hookCommand("0.2.0"))).toBe(true);
    expect(isStashwiseHookCommand(hookCommand("9.9.9"))).toBe(true);
  });

  it("does not match the MCP server or other commands", () => {
    expect(isStashwiseHookCommand("npx -y --package @stashwiseapp/mcp@0.2.0 mcp")).toBe(false);
    expect(isStashwiseHookCommand("npx some-other-package hook")).toBe(false);
    expect(isStashwiseHookCommand(undefined)).toBe(false);
  });
});

describe("installHookEntry / removeHookEntry", () => {
  it("installs into empty settings", () => {
    const { settings, changed } = installHookEntry({}, hookCommand("0.2.0"));
    expect(changed).toBe(true);
    expect(settings.hooks?.UserPromptSubmit).toEqual([
      {
        hooks: [
          { type: "command", command: hookCommand("0.2.0"), timeout: 10 },
        ],
      },
    ]);
  });

  it("is idempotent for the same version", () => {
    const first = installHookEntry({}, hookCommand("0.2.0"));
    const second = installHookEntry(first.settings, hookCommand("0.2.0"));
    expect(second.changed).toBe(false);
    expect(second.settings.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it("replaces the pin in place on a version bump", () => {
    const first = installHookEntry({}, hookCommand("0.2.0"));
    const second = installHookEntry(first.settings, hookCommand("0.3.0"));
    expect(second.changed).toBe(true);
    const entries = second.settings.hooks?.UserPromptSubmit ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks?.[0].command).toBe(hookCommand("0.3.0"));
  });

  it("preserves unrelated settings, events, and hooks", () => {
    const settings: ClaudeSettings = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "other-tool run" }] },
        ],
      },
    };
    const { settings: out } = installHookEntry(settings, hookCommand("0.2.0"));
    expect(out.model).toBe("opus");
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(out.hooks?.UserPromptSubmit?.[0].hooks?.[0].command).toBe("other-tool run");
  });

  it("uninstall removes the entry and cleans up empties", () => {
    const installed = installHookEntry({}, hookCommand("0.2.0")).settings;
    const { settings, removed } = removeHookEntry(installed);
    expect(removed).toBe(true);
    expect(settings.hooks).toBeUndefined();
  });

  it("uninstall keeps sibling hooks in a shared entry", () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: "command", command: "other-tool run" },
              { type: "command", command: hookCommand("0.2.0"), timeout: 10 },
            ],
          },
        ],
      },
    };
    const { settings: out, removed } = removeHookEntry(settings);
    expect(removed).toBe(true);
    expect(out.hooks?.UserPromptSubmit?.[0].hooks).toEqual([
      { type: "command", command: "other-tool run" },
    ]);
  });

  it("uninstall reports nothing removed on untouched settings", () => {
    expect(removeHookEntry({}).removed).toBe(false);
    expect(
      removeHookEntry({ hooks: { UserPromptSubmit: [] } }).removed,
    ).toBe(false);
  });
});
