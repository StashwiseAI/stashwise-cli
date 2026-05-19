# @stashwise/mcp

Search your Stashwise library + wiki from any AI agent — Claude Code, Codex CLI, Cursor, Claude desktop.

## Install

Drop one block into your agent host's MCP config — no separate install step.

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "stashwise": {
      "command": "npx",
      "args": ["-y", "@stashwise/mcp"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`) use the same JSON shape.

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.stashwise]
command = "npx"
args = ["-y", "@stashwise/mcp"]
```

## One-time login

```sh
npx -y @stashwise/mcp auth
```

Opens [stashwise.co/cli](https://stashwise.co/cli) in your browser. Sign in, click Authorize, and the CLI stores a long-lived token in your OS keychain. The agent picks it up automatically on its next tool call.

## What the agent sees

One tool, `search_stashwise(query, k, scope)`. Returns ranked snippets from your saved content with citations:

```json
{
  "results": [
    {
      "kind": "content",
      "id": "...",
      "title": "Why HNSW is the default vector index",
      "snippet": "HNSW (Hierarchical Navigable Small World) graphs trade...",
      "source_url": "https://...",
      "source_platform": "article",
      "score": 0.87,
      "citation": "Why HNSW is the default vector index — example.com",
      "saved_at": "2026-05-12T18:22:13+00:00"
    }
  ],
  "query": "vector index choice",
  "retrieval_ms": 41
}
```

## Diagnostics

```sh
npx -y @stashwise/mcp doctor
```

Prints config, token validity, and backend reachability. Use when the agent reports it can't reach your Stashwise content.

## Manage tokens

Visit [stashwise.co/account/mcp](https://stashwise.co/account/mcp) to see all authorized agents and revoke any of them.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `STASHWISE_API_URL` | `https://stashwise-api.fly.dev/api/v1` | Backend base URL |
| `STASHWISE_WEB_URL` | `https://stashwise.co` | Webapp base URL (used in auth flow) |

## License

MIT
