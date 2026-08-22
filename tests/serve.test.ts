import { describe, expect, it } from "vitest";
import { CONNECTOR_INSTRUCTIONS, TOOL_DEFINITIONS } from "../src/serve.js";

describe("Stashwise MCP tools", () => {
  it("requires complete context after lightweight search", () => {
    const search = TOOL_DEFINITIONS.find(
      (tool) => tool.name === "search_stashwise",
    );
    const context = TOOL_DEFINITIONS.find(
      (tool) => tool.name === "get_stashwise_context",
    );

    expect(search?.description).toContain("Results are candidates, not evidence");
    expect(search?.description).toContain("passed as `result_id`");
    expect(context?.description).toContain("full item");
    expect(context?.description).toContain("raw content");
    expect(context?.description).toContain("takeaways");
    expect(context?.description).toContain("full wiki page");
    expect(context?.description).toContain("claims");

    expect(context?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["content", "entity"] },
        result_id: { type: "string" },
      },
      required: ["kind", "result_id"],
    });
  });

  it("exposes folder writes with safe annotations and no delete tool", () => {
    const byName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toContain("list_stashwise_categories");
    expect([...byName.keys()]).toContain("create_stashwise_folder");
    expect([...byName.keys()]).toContain("move_stashwise_items");
    expect([...byName.keys()].some((name) => name.includes("delete"))).toBe(false);

    expect(byName.get("create_stashwise_folder")?.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
    expect(byName.get("move_stashwise_items")?.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    });
    expect(byName.get("list_stashwise_categories")?.description).toContain(
      "full path",
    );
  });
});

describe("connector-level routing", () => {
  // This string is sent on `initialize` and decides whether a host loads these
  // tools at all. Hosts that defer tool loading see only the server name and
  // this text first, so the tool descriptions are downstream of it. This server
  // sent nothing until now, which left it no way to win that step.
  it("names the trigger cases rather than leaving an inference to make", () => {
    const text = CONNECTOR_INSTRUCTIONS.toLowerCase();

    // Deictic recall routes to conversation memory unless spelled out.
    expect(text).toContain("what was that tool that");
    expect(text).toContain("one line question still counts");

    // Question types named outright, not implied.
    for (const kind of ["research", "planning", "recommendation", "comparison"]) {
      expect(text).toContain(kind);
    }

    // Discretion removed, and precedence over the host's own search stated.
    expect(text).toContain("search rather than skip");
    expect(text).toContain("do not substitute a public web search");

    // Still bounded, so it does not fire on everything.
    expect(text).toContain("skip it only for greetings");
  });

  it("stays in step with the hosted server's trigger wording", () => {
    // The two surfaces drifting is what caused the original miss: the hosted
    // server kept the terse description while the CLI carried the good one.
    for (const phrase of [
      "even when the user never mentions stashwise",
      "before falling back on conversation memory",
    ]) {
      expect(CONNECTOR_INSTRUCTIONS.toLowerCase()).toContain(phrase);
    }
  });
});
