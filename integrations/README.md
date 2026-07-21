# Hosted Stashwise integration

The hosted MCP endpoint is `https://stashwise-api.fly.dev/mcp/`. It uses OAuth and does not require Node, `npx`, an API token, or OS-keychain setup.

## Codex

### Install in one command

On macOS or Linux, run:

```bash
curl -fsSL https://raw.githubusercontent.com/StashwiseAI/stashwise-cli/main/scripts/install-codex-plugin.sh | sh
```

The installer uses Codex's native plugin commands to register the official Stashwise marketplace and install `stashwise@stashwise`. It is safe to rerun for updates and migrates the earlier `stashwise@personal` beta installation. You can [inspect the installer](../scripts/install-codex-plugin.sh) before running it.

On Windows, or to perform the same steps manually, run:

```text
codex plugin marketplace add StashwiseAI/stashwise-cli --ref main
codex plugin add stashwise@stashwise
```

The plugin contains the remote MCP definition, retrieval skill, and a local `UserPromptSubmit` hook. Codex opens the Stashwise authorization screen during installation when the connection is not already authorized.

### Finish onboarding

After installing or updating, open `/hooks` in Codex, review and trust the Stashwise hook, and then start a new task. The hook only injects relevance guidance; it does not transmit prompts or access credentials. Authenticated searches continue through the hosted MCP connection. If the hook is disabled or untrusted, explicit Stashwise requests still work through the skill and MCP tools.

Use these checks in the new task:

1. Ask a research question that does not mention Stashwise. Codex should search only when saved research is relevant, hydrate the useful results, and incorporate the full item takeaways and wiki context.
2. Say `hello`. Codex should not search Stashwise.
3. Ask `Use Stashwise to list my categories`. Explicit tool use should still work even with the hook disabled.
4. Ask to save a URL. Codex should write only because the prompt explicitly requests it.

Codex Cloud does not run this local lifecycle hook. The plugin skill remains the fallback there and still teaches the agent when and how to search Stashwise.

Search results are intentionally compact candidate matches. Before using one as evidence, agents call `get_stashwise_context`: content matches return the full saved item, takeaways, notes, links, and wiki entities; wiki matches return the full synthesized page, source items and their takeaways, claims, contradictions, and related entities.

## Cursor

Import [`cursor.mcp.json`](./cursor.mcp.json) as the user-level MCP configuration. Cursor discovers the Stashwise OAuth flow from the remote server on first connection.

## Claude

Add a remote custom connector with the URL `https://stashwise-api.fly.dev/mcp/`. Claude discovers OAuth from the server and returns to the connector after the user approves access on stashwise.co.

The npm CLI remains available for local stdio clients and for Claude Code's proactive prompt hook.
