import { describe, expect, it } from "vitest";
import type { AgentSearchResultItem } from "../src/api.js";
import {
  buildHookResponse,
  filterSuggestions,
  formatSuggestions,
  formatUserNotice,
  gateOpens,
  measureShape,
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
    const results = [item({ id: "a", score: 0.62 }), item({ id: "b", score: 0.5 })];
    const kept = filterSuggestions(results, 0.35, new Set(["a"]));
    expect(kept.map((r) => r.id)).toEqual(["b"]);
  });

  it("caps at three suggestions", () => {
    const scores = [0.7, 0.62, 0.58, 0.55, 0.52];
    const results = scores.map((score, i) => item({ id: `id-${i}`, score }));
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
    // entity bar. The leader gives the pack a shape so the gate opens and
    // the per kind floor is what decides between the two mid scorers.
    const results = [
      item({ id: "content-lead", kind: "content", score: 0.7 }),
      item({ id: "entity-mid", kind: "entity", score: 0.57, source_url: null }),
      item({ id: "content-mid", kind: "content", score: 0.57 }),
    ];
    const kept = filterSuggestions(results, 0.45, new Set());
    expect(kept.map((r) => r.id)).toEqual(["content-lead", "content-mid"]);
  });

  it("still admits a strongly matching entity", () => {
    // The Ahrefs entity scored 0.68 when the prompt was actually about it.
    const results = [
      item({ id: "entity-strong", kind: "entity", score: 0.68, source_url: null }),
    ];
    expect(filterSuggestions(results, 0.45, new Set())).toHaveLength(1);
  });

  it("stays silent on a flat pack even when every score clears the floor", () => {
    // The regression this gating exists for: "how should I structure skills
    // for an AI agent" returned five near tied results, two of them above
    // the content floor, none of which informed the answer.
    const results = [
      item({ id: "a", kind: "content", score: 0.581 }),
      item({ id: "b", kind: "content", score: 0.555 }),
      item({ id: "c", kind: "entity", score: 0.553, source_url: null }),
      item({ id: "d", kind: "entity", score: 0.539, source_url: null }),
      item({ id: "e", kind: "entity", score: 0.534, source_url: null }),
    ];
    expect(filterSuggestions(results, 0.45, new Set())).toEqual([]);
  });

  it("stays silent when a strong leader exists but only as a bare stub", () => {
    // "Basic AI Agents" scored 0.712 with an empty summary. It must neither
    // fill a slot nor lend its prominence to the flat pack beneath it.
    const results = [
      item({ id: "stub", kind: "entity", score: 0.712, snippet: "", source_url: null }),
      item({ id: "a", kind: "content", score: 0.581 }),
      item({ id: "b", kind: "content", score: 0.555 }),
      item({ id: "c", kind: "entity", score: 0.553, source_url: null }),
      item({ id: "d", kind: "entity", score: 0.539, source_url: null }),
    ];
    expect(filterSuggestions(results, 0.45, new Set())).toEqual([]);
  });
});

describe("measureShape", () => {
  it("ignores stubs when picking the leader", () => {
    const shape = measureShape([
      item({ id: "stub", score: 0.9, snippet: "" }),
      item({ id: "real", score: 0.6 }),
      item({ id: "tail", score: 0.5 }),
    ]);
    expect(shape.usable.map((r) => r.id)).toEqual(["real", "tail"]);
    expect(shape.top1).toBeCloseTo(0.6);
    expect(shape.prominence).toBeCloseTo(0.1);
  });

  it("gives a lone usable result its own score as prominence", () => {
    const shape = measureShape([item({ score: 0.55 })]);
    expect(shape.prominence).toBeCloseTo(0.55);
  });

  it("reports an empty shape when nothing is usable", () => {
    const shape = measureShape([item({ snippet: "" }), item({ snippet: "tiny" })]);
    expect(shape.usable).toEqual([]);
    expect(shape.top1).toBe(0);
  });
});

describe("gateOpens", () => {
  // Frozen from scripts/calibrate-gating.mjs against the live library on
  // 2026-07-21, after flow-app#159 stopped serving summaryless entities.
  // Every probe now fills all six slots with readable results; previously
  // stubs occupied one to four of them and were discarded client side.
  //
  // Removing the stubs moved the two weakest silent probes up, because the
  // padding at the bottom of their distributions went away:
  //
  //   probe                    before   after
  //   structure skills          0.036   0.042
  //   gibberish                 0.009   0.042
  //   unrelated but coherent    0.013   0.031
  //   the three inject probes  unchanged (stubs never ranked in them)
  //
  // The decision boundary still separates cleanly, 0.042 against 0.109, and
  // PROMINENCE_MIN of 0.07 sits inside it. The midpoint has drifted to
  // 0.0755, so the gate is now marginally biased toward injecting; worth
  // revisiting if a future calibration narrows the gap further.
  const PROBES: Array<{ name: string; open: boolean; scores: number[] }> = [
    { name: "structure skills (false positive)", open: false, scores: [0.581, 0.555, 0.553, 0.539, 0.534, 0.515] },
    { name: "semrush alternatives", open: true, scores: [0.638, 0.515, 0.469, 0.458, 0.418, 0.407] },
    { name: "deepseek locally", open: true, scores: [0.606, 0.499, 0.416, 0.405, 0.391, 0.37] },
    { name: "first users from reddit", open: true, scores: [0.481, 0.445, 0.378, 0.357, 0.35, 0.33] },
    { name: "gibberish", open: false, scores: [0.344, 0.339, 0.311, 0.284, 0.262, 0.258] },
    { name: "unrelated but coherent", open: false, scores: [0.212, 0.199, 0.191, 0.189, 0.179, 0.149] },
  ];

  // These arrays are dated snapshots, not live assertions. They drifted three
  // times in a single afternoon: once when the backend stopped serving
  // summaryless entities, once when 13 junk entities were purged, and once
  // from the ordinary churn of saving things. A future calibration returning
  // different numbers is normal and is not by itself a regression.
  //
  // What must hold is the *shape* claim each row encodes: a flat pack stays
  // shut, a peaked one opens. That is what the assertions below test, and it
  // is stable in a way the underlying scores are not.
  //
  // Note also that gibberish and the unrelated probe are held shut twice over,
  // by MIN_TOP_SCORE as well as by prominence (top1 of 0.344 and 0.212 against
  // a 0.42 floor). Their prominence can drift freely without threatening
  // anything. Only the "structure skills" row rests on prominence alone, since
  // its 0.581 leader clears the absolute guard, so that is the row whose
  // margin is worth watching. It has held at 0.042 against the 0.07 threshold
  // across every calibration so far.

  for (const probe of PROBES) {
    it(`${probe.open ? "opens" : "stays shut"} for ${probe.name}`, () => {
      const results = probe.scores.map((score, i) => item({ id: `p-${i}`, score }));
      expect(gateOpens(measureShape(results))).toBe(probe.open);
    });
  }

  it("stays shut below the absolute top score guard", () => {
    // One item standing clear of worse junk is still junk.
    const results = [item({ id: "a", score: 0.4 }), item({ id: "b", score: 0.2 })];
    expect(gateOpens(measureShape(results))).toBe(false);
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

  it("no longer leans on the model to notify the user", () => {
    const block = formatSuggestions([item()]);
    // Both shipped wordings failed in real sessions. Delivery moved to
    // systemMessage, so this block must not claim the user cannot see it.
    expect(block).not.toMatch(/cannot see this block/);
    expect(block).not.toMatch(/REQUIRED:/);
  });

  it("invites a refined pull query when the pushed matches miss", () => {
    // The push path only ever queries the raw prompt. Without this line the
    // model never issues a second, better targeted search.
    const block = formatSuggestions([item()]);
    expect(block).toContain("search_stashwise");
    expect(block).toMatch(/refined to their actual intent/);
  });
});

describe("formatUserNotice", () => {
  it("lists titles with a count", () => {
    const notice = formatUserNotice([item({ title: "Orca" }), item({ title: "Pi" })]);
    expect(notice).toBe("Stashwise · 2 related saves: Orca · Pi");
  });

  it("uses the singular for one match", () => {
    expect(formatUserNotice([item({ title: "Orca" })])).toBe(
      "Stashwise · 1 related save: Orca",
    );
  });

  it("truncates a very long title", () => {
    const notice = formatUserNotice([item({ title: "x".repeat(120) })]);
    expect(notice.length).toBeLessThan(110);
    expect(notice).toContain("…");
  });
});

describe("buildHookResponse", () => {
  it("emits both channels in valid JSON", () => {
    const parsed = JSON.parse(buildHookResponse([item()]));
    expect(parsed.systemMessage).toContain("Stashwise");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "<stashwise-suggestions>",
    );
  });

  it("keeps the user notice independent of the model context block", () => {
    // The whole point of the redesign: the user is told even if the model
    // never relays anything from additionalContext.
    const parsed = JSON.parse(buildHookResponse([item({ title: "Orca" })]));
    expect(parsed.systemMessage).toContain("Orca");
    expect(parsed.systemMessage).not.toContain("<stashwise-suggestions>");
  });

  it("survives titles containing quotes and newlines", () => {
    const raw = buildHookResponse([item({ title: 'He said "hi"\nthen left' })]);
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).not.toContain("\n");
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
