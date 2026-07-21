// Stdio MCP server. Exposes one tool: `search_stashwise`.
//
// Tools that 401 on the backend (token revoked / unknown) return a
// structured error message guiding the user back through `auth` rather
// than crashing — agents surface that text directly to the user.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, StashwiseApi } from "./api.js";
import { loadConfig } from "./config.js";
import { getStoredToken } from "./keychain.js";
import { notAuthenticatedHint } from "./messages.js";
import { VERSION } from "./version.js";

const SearchInputSchema = z.object({
  query: z
    .string()
    .min(1, "query is required")
    .max(2000, "query is too long"),
  k: z.number().int().min(1).max(25).default(8),
  scope: z.enum(["library", "wiki", "all"]).default("all"),
});

const TOOL_NAME = "search_stashwise";

// The description carries the one instruction the prompt hook structurally
// cannot deliver.
//
// 0.3.0 added a line inviting a refined re-search, but it lives inside the
// suggestion block, which is only emitted when the hook decides to suggest
// something. On a silent prompt — precisely the case the invitation was
// written for — nothing is printed and the instruction never arrives. Putting
// it here instead makes it unconditional: the description is in the agent's
// context whenever the server is connected, costs nothing per prompt, and
// reaches Cursor and Codex rather than Claude Code alone.
//
// Both added sentences are conditionals keyed to something the agent can
// observe (is this a topic the user might have saved; did a suggestion name
// only one item), not prohibitions, which agents negotiate with under a
// competing incentive.
const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Search the signed-in Stashwise user's saved library and wiki for content semantically related to `query`. " +
    "Returns up to `k` ranked snippets with citations (title, source URL, snippet, score). " +
    "Use this to ground answers in what the user has actually saved. " +
    "If the user asks about a topic they plausibly saved something about, search before answering, even when they do not mention Stashwise and did not ask you to. " +
    "If a suggestion was already surfaced for this prompt, it was matched against the raw prompt text alone; when it looks incomplete or off target, search again with a query refined to what the user actually means.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query.",
      },
      k: {
        type: "integer",
        description: "Max results to return (1 to 25). Default 8.",
        minimum: 1,
        maximum: 25,
        default: 8,
      },
      scope: {
        type: "string",
        enum: ["library", "wiki", "all"],
        description:
          "Limit to library (saved items), wiki (extracted entities), or both. Default `all`.",
        default: "all",
      },
    },
    required: ["query"],
  },
};

export async function runServe(): Promise<number> {
  const config = loadConfig();
  const api = new StashwiseApi(config);

  const server = new Server(
    { name: "@stashwiseapp/mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [TOOL_DEFINITION],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [
          { type: "text", text: `Unknown tool: ${request.params.name}` },
        ],
        isError: true,
      };
    }

    const parse = SearchInputSchema.safeParse(request.params.arguments ?? {});
    if (!parse.success) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid arguments: ${parse.error.issues
              .map((i) => i.message)
              .join("; ")}`,
          },
        ],
        isError: true,
      };
    }

    const token = await getStoredToken();
    if (!token) {
      return {
        content: [{ type: "text", text: notAuthenticatedHint() }],
        isError: true,
      };
    }

    try {
      const result = await api.search(
        token,
        parse.data.query,
        parse.data.k,
        parse.data.scope,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        return {
          content: [{ type: "text", text: notAuthenticatedHint() }],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Search failed: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until the host closes stdio. Resolving here would end the
  // process; instead we return a never-resolving promise so the runtime
  // stays alive.
  return new Promise<number>(() => {
    /* deliberately never resolves */
  });
}
