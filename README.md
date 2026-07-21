<p align="center">
  <img src="assets/lantern.png" alt="Stashwise" width="104" height="104" />
</p>

<h1 align="center">@stashwiseapp/mcp</h1>

<p align="center">
  <strong>Search everything you've saved in <a href="https://stashwise.co">Stashwise</a> — from any AI agent, or straight from your terminal.</strong>
</p>

Stashwise is a personal knowledge base: you save articles, videos, threads, and posts, and it turns them into an AI-organized library and wiki. This package is the official [MCP](https://modelcontextprotocol.io) server that gives **Claude Code, Cursor, Codex, and Claude Desktop** a single tool — `search_stashwise` — to ground their answers in what *you've* actually saved, with citations back to the source.

No account yet? [Create one at stashwise.co](https://stashwise.co/signup) and save a few things first — the search only returns *your* library and wiki.

---

## Prerequisites

- **Node.js ≥ 18** (`node --version`). `npx` ships with npm.
- A **Stashwise account** with some saved content.

That's it — there's nothing to globally install. Every command below runs the package on demand via `npx -y --package @stashwiseapp/mcp@latest mcp`.

---

## Quick start

It's two steps: **(1)** add the server to your agent, **(2)** run `auth` once.

### 1 · Add the server

Pick your host — each is a one-liner (or one click):

**Claude Code**

```bash
claude mcp add -s user stashwise -- npx -y --package @stashwiseapp/mcp@latest mcp
```

**Cursor** — [**▸ Add to Cursor**](cursor://anysphere.cursor-deeplink/mcp/install?name=stashwise&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcGFja2FnZSIsIkBzdGFzaHdpc2VhcHAvbWNwQGxhdGVzdCIsIm1jcCJdfQ)

…or add it manually to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stashwise": {
      "command": "npx",
      "args": ["-y", "--package", "@stashwiseapp/mcp@latest", "mcp"]
    }
  }
}
```

**Codex CLI**

```bash
codex mcp add stashwise -- npx -y --package @stashwiseapp/mcp@latest mcp
```

…or add it manually to `~/.codex/config.toml`:

```toml
[mcp_servers.stashwise]
command = "npx"
args = ["-y", "--package", "@stashwiseapp/mcp@latest", "mcp"]
```

**Claude Desktop** — edit the config file (no CLI), then restart the app:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "stashwise": {
      "command": "npx",
      "args": ["-y", "--package", "@stashwiseapp/mcp@latest", "mcp"]
    }
  }
}
```

### 2 · Authorize (run once)

```bash
npx -y --package @stashwiseapp/mcp@latest mcp auth
```

This opens the pairing page at **[stashwise.co/cli](https://stashwise.co/cli)** in your browser. Sign in, click **Authorize**, and a long-lived token is saved to your **OS keychain** (macOS Keychain / Windows Credential Vault / Linux libsecret). Your agent picks it up automatically on its next search.

> **Run `auth` before your first search.** Without it, the tool replies "not authenticated." Headless/SSH box? `auth` also prints a URL and an 8-character code you can enter manually at `stashwise.co/cli`.

---

## Verify it works

From the terminal — no agent required:

```bash
npx -y --package @stashwiseapp/mcp@latest mcp search "what did I save about HNSW indexes"
```

```
Results for "what did I save about HNSW indexes" (scope: all)

 1. Approximate Nearest Neighbors with HNSW  ·  youtube  ·  score 0.83
    A walkthrough of hierarchical navigable small-world graphs and how the …
    https://youtube.com/watch?v=…

 2. pgvector HNSW tuning notes  ·  github  ·  score 0.79
    ef_search vs ef_construction trade-offs when indexing embeddings …
    https://github.com/…

2 results · 138ms
```

Or just ask your agent: *"Search my Stashwise for what I saved about HNSW indexes."*

`search` flags:

| Flag | Values | Default | Meaning |
|---|---|---|---|
| `--scope` | `library` · `wiki` · `all` | `all` | Search saved items, extracted wiki entities, or both. |
| `--k` | `1`–`25` | `8` | Max results to return. |

```bash
npx -y --package @stashwiseapp/mcp@latest mcp search rust borrow checker --scope wiki --k 5
```

---

## The tool

Your agent gets one tool:

### `search_stashwise(query, k, scope)`

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string (required) | — | Natural-language search query. |
| `k` | integer 1–25 | `8` | Max results. |
| `scope` | `library` · `wiki` · `all` | `all` | What to search. |

Returns ranked snippets with citations. Shape:

```json
{
  "query": "HNSW indexes",
  "retrieval_ms": 138,
  "results": [
    {
      "kind": "content",
      "id": "…",
      "title": "Approximate Nearest Neighbors with HNSW",
      "snippet": "A walkthrough of hierarchical navigable small-world graphs…",
      "source_url": "https://youtube.com/watch?v=…",
      "source_platform": "youtube",
      "score": 0.83,
      "citation": "Approximate Nearest Neighbors with HNSW — youtube",
      "saved_at": "2026-05-02T11:20:00Z"
    }
  ]
}
```

It maps to the backend endpoint `POST /api/v1/agent/search`.

---

## Proactive suggestions in Claude Code

The MCP tool only fires when the agent decides to call it. The prompt hook makes your library ambient instead: every prompt you submit in Claude Code is semantically checked against your Stashwise saves, and strong matches are injected as context, so Claude can say "you saved a reel about exactly this" without you ever mentioning Stashwise.

```bash
npx -y --package @stashwiseapp/mcp@latest mcp hook install     # register in ~/.claude/settings.json
npx -y --package @stashwiseapp/mcp@latest mcp hook uninstall   # remove it
```

`install` registers a `UserPromptSubmit` hook at the user level, so it works in every project on this machine. It pins the command to the currently installed version so npx serves it from cache on each prompt; rerun `install` after upgrading to move the pin.

Built to stay out of the way:

- **High confidence only.** At most 3 items, and only when the semantic score clears a threshold (default 0.45). Below it, the hook prints nothing.
- **Saved material first.** Wiki entities are derived abstractions with nothing to open, and they match incidental mentions (a generic `TypeScript` page against any type error). They are held to a higher bar than saved content, and any result without a real summary is dropped rather than shown as a bare title.
- **No repeats.** An item is suggested at most once per Claude Code session.
- **Never blocks, never nags.** Missing token, unreachable backend, timeout (default 2500 ms), or malformed input all exit silently. Your prompt always goes through untouched.

Tune it by editing the command in `~/.claude/settings.json`:

```
mcp hook --min-score 0.5 --k 10 --timeout-ms 4000
```

Set `STASHWISE_HOOK_DEBUG=1` to see why the hook stayed silent (stderr only).

---

## Diagnostics

```bash
npx -y --package @stashwiseapp/mcp@latest mcp doctor
```

Prints your resolved config, whether the stored token is valid, and whether the backend is reachable. Run this first when something's off.

```bash
npx -y --package @stashwiseapp/mcp@latest mcp --version   # print the installed version
npx -y --package @stashwiseapp/mcp@latest mcp --help      # full usage
```

---

## Manage authorized agents

See and revoke every machine you've paired at **[stashwise.co/account/mcp](https://stashwise.co/account/mcp)**.

---

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `STASHWISE_API_URL` | `https://stashwise-api.fly.dev/api/v1` | Backend base URL. |
| `STASHWISE_WEB_URL` | `https://stashwise.co` | Webapp base URL (used by the `auth` flow). |

Pointing at a local backend during development:

```bash
STASHWISE_API_URL=http://127.0.0.1:8000/api/v1 npx -y --package @stashwiseapp/mcp@latest mcp search "test"
```

---

## Troubleshooting

- **"Stashwise is not authenticated."** — Run `npx -y --package @stashwiseapp/mcp@latest mcp auth`. If a search worked before and suddenly returns this, your token may have been revoked at `stashwise.co/account/mcp` — just re-run `auth`.
- **Agent doesn't see the tool** — Restart the host after editing its config (Claude Desktop especially). In Claude Code, run `/mcp` to confirm `stashwise` is connected.
- **`OS keychain unavailable …` warning** — Expected on some headless/CI Linux boxes without libsecret. The token falls back to `~/.stashwise/credentials.json` (mode `0600`); everything still works.
- **Still stuck?** — `npx -y --package @stashwiseapp/mcp@latest mcp doctor` reports config, token validity, and backend reachability.

---

## License

MIT
