import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/serve.js";

describe("Stashwise MCP retrieval tools", () => {
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
});
