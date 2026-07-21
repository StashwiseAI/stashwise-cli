# Hosted Stashwise integration

The hosted MCP endpoint is `https://stashwise-api.fly.dev/mcp`. It uses OAuth and does not require Node, `npx`, an API token, or OS-keychain setup.

## Codex

Install the Stashwise Codex plugin from this repository's marketplace. The plugin contains the remote MCP definition and retrieval skill; Codex opens the Stashwise authorization screen during installation.

## Cursor

Import [`cursor.mcp.json`](./cursor.mcp.json) as the user-level MCP configuration. Cursor discovers the Stashwise OAuth flow from the remote server on first connection.

## Claude

Add a remote custom connector with the URL `https://stashwise-api.fly.dev/mcp`. Claude discovers OAuth from the server and returns to the connector after the user approves access on stashwise.co.

The npm CLI remains available for local stdio clients and for Claude Code's proactive prompt hook.
