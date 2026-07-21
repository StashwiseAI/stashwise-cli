// Stdio MCP server. Legacy device credentials are read-only; write tools live
// on the hosted OAuth MCP endpoint bundled by the Codex plugin.
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

const RecentInputSchema = z.object({
  days: z.number().int().min(1).max(30).default(1),
  k: z.number().int().min(1).max(50).default(12),
  scope: z.enum(["library", "wiki", "all"]).default("all"),
});

const ItemInputSchema = z.object({
  content_id: z.string().min(1, "content_id is required"),
});

const ContextInputSchema = z.object({
  kind: z.enum(["content", "entity"]),
  result_id: z.string().min(1, "result_id is required"),
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
    "If a suggestion was already surfaced for this prompt, it was matched against the raw prompt text alone; when it looks incomplete or off target, search again with a query refined to what the user actually means. " +
    "Search results are candidates, not complete evidence: call `get_stashwise_context` with each used result's `kind` and `id` (passed as `result_id`) before a substantive answer.",
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

export const TOOL_DEFINITIONS = [
  TOOL_DEFINITION,
  {
    name: "get_recent_stashwise",
    description:
      "Return the signed-in user's recent Stashwise saves and wiki entities for date-oriented questions.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30, default: 1 },
        k: { type: "integer", minimum: 1, maximum: 50, default: 12 },
        scope: { type: "string", enum: ["library", "wiki", "all"], default: "all" },
      },
    },
  },
  {
    name: "get_stashwise_item",
    description: "Get the full stored details for one Stashwise library item by id.",
    inputSchema: {
      type: "object",
      properties: { content_id: { type: "string" } },
      required: ["content_id"],
    },
  },
  {
    name: "get_stashwise_context",
    description:
      "Hydrate a search result before using it in a substantive answer. For kind `content`, returns the full item including raw content, takeaways, notes, links, and its wiki entities. For kind `entity`, returns the full wiki page including source items and their takeaways, claims, contradictions, and related entities.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["content", "entity"] },
        result_id: { type: "string" },
      },
      required: ["kind", "result_id"],
    },
  },
  {
    name: "list_stashwise_categories",
    description: "List the signed-in user's Stashwise categories and their ids.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function runServe(): Promise<number> {
  const config = loadConfig();
  const api = new StashwiseApi(config);

  const server = new Server(
    { name: "@stashwiseapp/mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!TOOL_DEFINITIONS.some((tool) => tool.name === request.params.name)) {
      return {
        content: [
          { type: "text", text: `Unknown tool: ${request.params.name}` },
        ],
        isError: true,
      };
    }

    const schema =
      request.params.name === TOOL_NAME
        ? SearchInputSchema
        : request.params.name === "get_recent_stashwise"
          ? RecentInputSchema
          : request.params.name === "get_stashwise_item"
            ? ItemInputSchema
            : request.params.name === "get_stashwise_context"
              ? ContextInputSchema
              : z.object({});
    const parse = schema.safeParse(request.params.arguments ?? {});
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
      let result: unknown;
      if (request.params.name === TOOL_NAME) {
        const args = SearchInputSchema.parse(parse.data);
        result = await api.search(token, args.query, args.k, args.scope);
      } else if (request.params.name === "get_recent_stashwise") {
        const args = RecentInputSchema.parse(parse.data);
        result = await api.recent(token, args.days, args.k, args.scope);
      } else if (request.params.name === "get_stashwise_item") {
        const args = ItemInputSchema.parse(parse.data);
        result = await api.getItem(token, args.content_id);
      } else if (request.params.name === "get_stashwise_context") {
        const args = ContextInputSchema.parse(parse.data);
        result = await api.getContext(token, args.kind, args.result_id);
      } else {
        result = await api.listCategories(token);
      }
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
