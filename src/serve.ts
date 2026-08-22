// Stdio MCP server. Newly paired credentials can manage folder organization;
// legacy read-only credentials keep working for retrieval and must be paired
// again before a write.
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

const FolderInputSchema = z.object({
  name: z.string().min(1, "name is required").max(255, "name is too long"),
  parent_id: z.string().min(1).nullable().optional(),
});

const MoveItemsInputSchema = z.object({
  content_ids: z
    .array(z.string().min(1, "content ids cannot be blank"))
    .min(1, "at least one content id is required")
    .max(100, "at most 100 content ids may be moved")
    .refine((ids) => new Set(ids).size === ids.length, "content ids must be unique"),
  category_id: z.string().min(1).nullable(),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;

const PRIVATE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
} as const;

const PRIVATE_OVERWRITE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: true,
} as const;

// Connector-level routing description, sent on `initialize`. This decides
// whether a host loads these tools AT ALL: hosts that defer tool loading see
// only the server name and this text first, so every tool description below is
// downstream of winning here. This server previously sent nothing, which left
// it with no way to win that step. Kept in sync with the hosted server's
// `instructions` in flow-app/backend/app/hosted_mcp.py — the two surfaces
// drifting is what caused the original miss.
export const CONNECTOR_INSTRUCTIONS = [
  "Stashwise is the connected user's personal research library: the articles, videos, " +
    "posts, and notes they saved, plus the wiki built from them. Treat it as their " +
    "memory layer and use it proactively.",
  'Always search for RESOURCE RECALL, even when the user never mentions Stashwise and ' +
    'never says they saved anything. Resource recall sounds like "what was that tool ' +
    'that...", "what was that app for...", "what was that article about...", "I remember ' +
    'seeing something that...", or "do I have anything about X?". Whenever the thing ' +
    "being recalled is a tool, app, site, article, video, post, product, library, " +
    "repository, technique, or idea, search Stashwise before falling back on conversation " +
    "memory or your own knowledge. Question length is irrelevant; a one line question " +
    "still counts.",
  "Also search before answering research, planning, strategy, comparison, recommendation, " +
    'or brainstorming questions whenever saved material could relate to the topic. "How do ' +
    'I get my first 100 users?", "which tool should I use for this?", and "help me plan ' +
    'this" all qualify.',
  "Where memories live: personal facts the user told you, and decisions made earlier in " +
    "conversation, are yours rather than Stashwise's. Anything they found, read, watched, " +
    "saved, or researched is Stashwise's. When a question could be either, check Stashwise " +
    "rather than guess.",
  "When you are unsure whether anything relevant is saved, search rather than skip. The " +
    "search is read only and typically returns in under 200ms. Do not substitute a public " +
    "web search for the user's own saved research: search Stashwise first, then add a web " +
    "search when genuinely current external facts are needed.",
  "Skip it only for greetings, tasks unrelated to knowledge, and requests that explicitly " +
    "ask for a general answer. Hydrate every result you rely on with get_stashwise_context " +
    "before making claims about it, and cite source URLs.",
].join("\n\n");

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
    "Search the signed-in Stashwise user's saved library and wiki: the articles, videos, posts, and notes they saved, plus the wiki built from them. " +
    "Returns up to `k` ranked candidates with citations (title, source URL, snippet, score). " +
    "Call this before answering research, comparison, planning, recommendation, or recall questions whenever the user's own saves could add evidence, even when they do not mention Stashwise and did not ask you to. " +
    'Always call it for resource recall, however short the question: "what was that tool that...", "what was that article about...", "I remember seeing something that...", "do I have anything about X?", and equally when they refer to "my research", "my library", "what I saved", or "what I read". ' +
    "Search is semantic rather than keyword based, so pass a short natural sentence in the user's own words and keep it to the topic itself; appending extra terms or platform names drags results toward saves that merely came from those platforms. " +
    "If a suggestion was already surfaced for this prompt, it was matched against the raw prompt text alone; when it looks incomplete or off target, search again with different phrasing rather than more terms. " +
    "Results are candidates, not evidence: call `get_stashwise_context` with each used result's `kind` and `id` (passed as `result_id`) before making claims about what it says.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A short natural-language phrase describing what the user wants to know, in "
          + "their own words. Matched semantically against the text of their saves, so a "
          + "plain sentence retrieves better than a keyword list.",
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
  annotations: READ_ONLY_ANNOTATIONS,
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
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "get_stashwise_item",
    description: "Get the full stored details for one Stashwise library item by id.",
    inputSchema: {
      type: "object",
      properties: { content_id: { type: "string" } },
      required: ["content_id"],
    },
    annotations: READ_ONLY_ANNOTATIONS,
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
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "list_stashwise_categories",
    description:
      "List every signed-in Stashwise folder with its id, full path, depth, child count, direct item count, and descendant total.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "create_stashwise_folder",
    description:
      "Create one Stashwise folder, optionally beneath an existing parent. Use only after the user explicitly asks to create or organize folders.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 255 },
        parent_id: {
          type: ["string", "null"],
          description: "Parent folder id, or null/omit to create at Library root.",
        },
      },
      required: ["name"],
    },
    annotations: PRIVATE_WRITE_ANNOTATIONS,
  },
  {
    name: "move_stashwise_items",
    description:
      "Move 1–100 Stashwise items into a folder, or use null for Unsorted. Use only after explicit user intent because this changes existing organization.",
    inputSchema: {
      type: "object",
      properties: {
        content_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 100,
        },
        category_id: {
          type: ["string", "null"],
          description: "Destination folder id, or null for Unsorted.",
        },
      },
      required: ["content_ids", "category_id"],
    },
    annotations: PRIVATE_OVERWRITE_ANNOTATIONS,
  },
];

export async function runServe(): Promise<number> {
  const config = loadConfig();
  const api = new StashwiseApi(config);

  const server = new Server(
    { name: "@stashwiseapp/mcp", version: VERSION },
    { capabilities: { tools: {} }, instructions: CONNECTOR_INSTRUCTIONS },
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
              : request.params.name === "create_stashwise_folder"
                ? FolderInputSchema
                : request.params.name === "move_stashwise_items"
                  ? MoveItemsInputSchema
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
      } else if (request.params.name === "create_stashwise_folder") {
        const args = FolderInputSchema.parse(parse.data);
        result = await api.createFolder(token, args.name, args.parent_id);
      } else if (request.params.name === "move_stashwise_items") {
        const args = MoveItemsInputSchema.parse(parse.data);
        result = await api.moveItems(token, args.content_ids, args.category_id);
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
      if (err instanceof ApiError && err.status === 403) {
        return {
          content: [
            {
              type: "text",
              text:
                "This Stashwise token is read-only. Rerun `stashwise auth` and approve the new folder-management access, then retry.",
            },
          ],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Stashwise request failed: ${message}` }],
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
