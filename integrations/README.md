# Hosted Stashwise integration

The hosted MCP endpoint is `https://stashwise-api.fly.dev/mcp/`. It uses OAuth and does not require Node, `npx`, an API token, or OS-keychain setup.

## Codex

Install the Stashwise Codex plugin from this repository's marketplace. The plugin contains the remote MCP definition, retrieval skill, and a local `UserPromptSubmit` hook; Codex opens the Stashwise authorization screen during installation.

After installing or updating, open `/hooks` in Codex, review and trust the Stashwise hook, and then start a new task. The hook only injects relevance guidance; it does not transmit prompts or access credentials. Authenticated searches continue through the hosted MCP connection. If the hook is disabled or untrusted, explicit Stashwise requests still work through the skill and MCP tools.

Codex Cloud does not run this local lifecycle hook. The plugin skill remains the fallback there and still teaches the agent when and how to search Stashwise.

## Cursor

Import [`cursor.mcp.json`](./cursor.mcp.json) as the user-level MCP configuration. Cursor discovers the Stashwise OAuth flow from the remote server on first connection.

## Claude

Add a remote custom connector with the URL `https://stashwise-api.fly.dev/mcp/`. Claude discovers OAuth from the server and returns to the connector after the user approves access on stashwise.co.

The npm CLI remains available for local stdio clients and for Claude Code's proactive prompt hook.
