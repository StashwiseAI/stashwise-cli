import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/serve.js";

describe("Stashwise MCP tools", () => {
  it("requires complete context after lightweight search", () => {
    const search = TOOL_DEFINITIONS.find(
      (tool) => tool.name === "search_stashwise",
    );
    const context = TOOL_DEFINITIONS.find(
      (tool) => tool.name === "get_stashwise_context",
    );

    expect(search?.description).toContain(
      "Search results are candidates, not complete evidence",
    );
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
