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
5. Ask to create a nested folder and move a known item. Codex should list folders first, create one node at a time, and move only after that explicit request. Folder and item deletion remain unavailable.

Codex Cloud does not run this local lifecycle hook. The plugin skill remains the fallback there and still teaches the agent when and how to search Stashwise.

Search results are intentionally compact candidate matches. Before using one as evidence, agents call `get_stashwise_context`: content matches return the full saved item, takeaways, notes, links, and wiki entities; wiki matches return the full synthesized page, source items and their takeaways, claims, contradictions, and related entities.

Write tools require explicit user intent. The connector may save material, create folders, and move items, but it cannot delete content, rename/reparent folders, or manage the user's account.

## Cursor

Import [`cursor.mcp.json`](./cursor.mcp.json) as the user-level MCP configuration. Cursor discovers the Stashwise OAuth flow from the remote server on first connection.

## Claude Code

### Install

```text
/plugin marketplace add StashwiseAI/stashwise-cli
/plugin install stashwise@stashwise
```

The repository root carries `.claude-plugin/marketplace.json`, so the same repository serves both the Codex and the Claude Code catalog and both resolve the plugin from `plugins/stashwise/`. The two hosts read different manifests inside that directory and share the skill, the hook, the MCP definition, and the icon.

Shell equivalents, for scripting or a first run outside a session:

```bash
claude plugin marketplace add StashwiseAI/stashwise-cli
claude plugin install stashwise@stashwise
```

### Finish onboarding

If the install summary reports `Run /reload-plugins to activate.`, run that command. Then open `/mcp`, select **stashwise**, and approve access on stashwise.co. Until you do, the server sits at `needs-auth` and no Stashwise tool is callable.

Claude Code auto-detects the plugin's `hooks/hooks.json`, so the ambient `UserPromptSubmit` hook is active as soon as the plugin is. `claude plugin details stashwise` prints the full inventory and the projected token cost.

Use these checks in a new session:

1. Ask a research question that does not mention Stashwise. Claude should search only when saved research is relevant, hydrate the useful results, and incorporate the full item takeaways and wiki context.
2. Say `hello`. Claude should not search Stashwise.
3. Ask `Use Stashwise to list my categories`. Explicit tool use should work regardless of the hook.
4. Ask to save a URL. Claude should write only because the prompt explicitly requests it.
5. Ask to create a nested folder and move a known item. Claude should list folders first, create one node at a time, and move only after that explicit request. Folder and item deletion remain unavailable.

### Do not stack the two Claude Code paths

The npm CLI (`npm i -g @stashwiseapp/mcp`, then `claude mcp add` and `stashwise hook install`) is a separate, complete path. Running it alongside the plugin gives you two `UserPromptSubmit` hooks and two copies of every tool: Claude Code deduplicates the three configuration scopes by server name, but matches plugin servers and connectors by endpoint, and the plugin's HTTPS endpoint never matches a local stdio command. Pick one.

The plugin path needs no Node, no `npx`, and no keychain. The CLI path adds a pre-search hook that runs a real search before the turn and injects the matches, rather than injecting guidance the way the ambient hook does. That is the tradeoff.

### Community marketplace

A listing in Anthropic's community marketplace is pending review. Once approved, the plugin also installs as:

```text
/plugin marketplace add anthropics/claude-plugins-community
/plugin install stashwise@claude-community
```

Approved plugins are pinned to a commit SHA in the community catalog and the public catalog syncs nightly, so installability lags approval. Check the [community catalog](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json) for the plugin name before pointing anyone at that command.

## Claude apps and other MCP hosts

Add a remote custom connector with the URL `https://stashwise-api.fly.dev/mcp/`. Claude discovers OAuth from the server and returns to the connector after the user approves access on stashwise.co.

The npm CLI remains available for local stdio clients.
