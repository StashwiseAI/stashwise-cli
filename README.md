<p align="center">
  <img src="assets/lantern.png" alt="Stashwise" width="104" height="104" />
</p>

<h1 align="center">stashwise</h1>

<p align="center">
  <strong>Your saved research, in every answer.</strong><br />
  <sub>the <code>stashwise</code> command, published as <a href="https://www.npmjs.com/package/@stashwiseapp/mcp"><code>@stashwiseapp/mcp</code></a></sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stashwiseapp/mcp"><img src="https://img.shields.io/npm/v/@stashwiseapp/mcp?color=%23c9a227&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/node/v/@stashwiseapp/mcp?color=%23c9a227" alt="node version" />
  <img src="https://img.shields.io/npm/l/@stashwiseapp/mcp?color=%23c9a227" alt="MIT license" />
</p>

[Stashwise](https://stashwise.co) is a personal knowledge base: you save articles, videos, threads and posts, and it turns them into an AI organized library and wiki. This package connects that library to **Claude Code, Cursor, Codex and Claude Desktop**, so the things you saved months ago show up in the answer you need today.

---

## What it actually looks like

You ask an ordinary question. You do not mention Stashwise, and you do not remember saving anything about it.

```console
❯ is there an open source alternative to ahrefs

  Stashwise · 1 related save: Ahrefs

⏺ Your library already has the answer's centerpiece. Let me verify
  its current state and see what else exists.

  ⎿  search_stashwise("open source SEO tool alternative")
  ⎿  Web Search("OpenSEO github bensenescu self-hosted")

  You saved OpenSEO in July: an open source, self hosted SEO tool
  built as an alternative to Semrush and Ahrefs, with agent
  integration for keyword research and competitor analysis.
  → x.com/bensenescu/status/2078737738493301060
```

Three things happened there, and only the first is automatic:

1. **The hook noticed.** Every prompt you submit is checked against your library. This one matched a save, so you got the one line notice naming it.
2. **The agent disagreed with the match.** It got `Ahrefs`, judged that the commercial tool was not what you were asking for, and searched your library again with a better query of its own.
3. **It found what the first pass missed** and answered from your own saved material, with the source link.

That second step is the point. The automatic check only sees your raw prompt, so it guesses before anyone has worked out what you are really asking. The agent can then go back with a sharper query.

---

## Install

### Hosted integration (recommended)

Codex, Cursor, and Claude can connect directly to the hosted Stashwise MCP endpoint:

```text
https://stashwise-api.fly.dev/mcp/
```

The hosted connection uses OAuth. Installing the Codex plugin—or adding the URL as a remote MCP connector in Cursor or Claude—opens Stashwise in the browser for approval. It does not require Node, `npx`, an API token, or OS-keychain setup. See [`integrations/`](./integrations/) for the client-specific assets.

The Codex plugin also teaches Codex when to consult saved research, how to refine an incomplete match, and when writes are appropriate. It can search and read the library/wiki, save URLs and research notes, and organize item metadata. Deletion is intentionally unavailable.

On local Codex surfaces, the plugin bundles an ambient `UserPromptSubmit` hook that reminds Codex to check Stashwise when saved research could materially improve an answer. The hook never reads credentials, sends the prompt over the network, or performs writes; searches still go through the OAuth-protected MCP tools. After installing or updating the plugin, open `/hooks`, review and trust the Stashwise hook, then start a new task. If the hook is disabled or untrusted, explicit Stashwise requests still work through the plugin skill and MCP server. Codex Cloud does not run the local lifecycle hook, so it uses that skill-based behavior instead.

### Local CLI and Claude Code hook

```bash
npm i -g @stashwiseapp/mcp
stashwise auth
```

`auth` opens [stashwise.co/cli](https://stashwise.co/cli), you click **Authorize**, and a token lands in your OS keychain (macOS Keychain, Windows Credential Vault, Linux libsecret). On a headless box it also prints a URL and an 8 character code you can enter by hand.

Then wire it into your agent. **Claude Code** gets both surfaces:

```bash
claude mcp add -s user stashwise -- stashwise    # the search tool
stashwise hook install                           # the automatic checking
```

<details>
<summary><b>Cursor, Codex, Claude Desktop, and running without a global install</b></summary>

The direct pre-search hook installed by `stashwise hook install` is Claude Code only. The Codex plugin has its own ambient lifecycle hook; Cursor and other MCP hosts get the Stashwise tools without a prompt hook.

**Cursor** · [**▸ Add to Cursor**](cursor://anysphere.cursor-deeplink/mcp/install?name=stashwise&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcGFja2FnZSIsIkBzdGFzaHdpc2VhcHAvbWNwQGxhdGVzdCIsInN0YXNod2lzZSJdfQ) or add it to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stashwise": { "command": "stashwise" }
  }
}
```

**Codex CLI**

```bash
codex mcp add stashwise -- stashwise
```

…or in `~/.codex/config.toml`:

```toml
[mcp_servers.stashwise]
command = "stashwise"
```

**Claude Desktop** · edit the config, then restart the app:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "stashwise": { "command": "stashwise" }
  }
}
```

**Prefer not to install globally?** Every command works through npx, and every config above accepts it in place of `"command": "stashwise"`:

```bash
npx -y --package @stashwiseapp/mcp@latest stashwise auth
```

```json
{
  "command": "npx",
  "args": ["-y", "--package", "@stashwiseapp/mcp@latest", "stashwise"]
}
```

</details>

No Stashwise account yet? [Create one](https://stashwise.co/signup) and save a few things first. Search only ever returns your own library.

---

## Two ways your library reaches the agent

**Pull** is the `search_stashwise` tool. The agent calls it when it decides your library is relevant, or when you ask directly. Works in every MCP host.

**Push** is host-specific. Claude Code's CLI hook searches each eligible prompt before the agent sees it and surfaces strong matches without anyone asking. The local Codex plugin hook injects relevance guidance before the turn, then Codex uses its existing OAuth MCP connection when a search is warranted. Codex Cloud and hosts without lifecycle hooks rely on the plugin skill or their own agent instructions.

Push is what makes the library ambient rather than something you have to remember to consult. It reaches you on two separate channels, deliberately:

| Channel | Goes to | Why |
|---|---|---|
| `systemMessage` | you | The harness always displays it, so you learn what you saved even if the answer never mentions it |
| `additionalContext` | the agent | So it can quote and cite the material inline |

Earlier versions put both in one channel and depended on the model to relay what it found. It often did not, particularly when a loaded skill dominated the answer.

---

## What the Claude Code pre-search costs you

The Claude Code pre-search hook runs on every eligible prompt you type, so this matters more than it would for an ordinary CLI. The Codex ambient hook makes no network request itself and adds only a short developer-context instruction.

| | |
|---|---|
| **Added latency** | **~180 ms** per prompt, warm. Measured 177 / 183 / 222 ms against production; roughly 130 to 170 ms of that is the search itself |
| **Hard timeout** | 2500 ms, then it gives up silently. Tunable |
| **Free prompts** | Anything under 15 characters, or starting with `/`, `!` or `#`, exits before any network call. Slash commands and shell lines cost nothing |
| **On failure** | Missing token, unreachable backend, timeout, malformed input: all exit quietly. Your prompt is never blocked, altered or delayed beyond the timeout |
| **What leaves your machine** | The prompt text, capped at 2000 characters, sent to your own account's backend. Nothing else |
| **How noisy** | At most 3 suggestions, and each item is offered at most once per session |

Set `STASHWISE_HOOK_DEBUG=1` to see on stderr why a given prompt stayed silent.

---

## When the Claude Code pre-search stays quiet

Most prompts produce nothing, by design. A suggestion has to be worth interrupting you for.

The test is not a fixed score. It is whether one result **stands out from the rest**. That distinction matters because similarity scores are not comparable between questions: a broad prompt like "how should I structure skills for an AI agent" lands near the middle of a whole topic cluster and scores respectably against a dozen mediocre matches, while a narrow one like "SKILL.md frontmatter" lands somewhere sparse and scores poorly against the single item that genuinely answers it. Any fixed threshold is therefore too low for the first and too high for the second.

So the hook looks at the shape of the results instead. A flat pack of similar scores means nothing stood out, and it stays silent no matter how high those scores are. A clear leader opens the gate.

On top of that:

- **Wiki entities are held to a higher bar than things you saved.** They are derived abstractions with no link to open, and they match incidental mentions: a generic `TypeScript` page will match any type error you ever paste.
- **Anything without a real summary is dropped** rather than shown as a bare title.
- **Nothing repeats within a session.**

---

## Reference

<details>
<summary><b>Commands</b></summary>

| Command | What it does |
|---|---|
| `stashwise` | Start the stdio MCP server. This is what agent hosts spawn; you rarely run it yourself |
| `stashwise auth` | Pair this machine with your account. Run once |
| `stashwise search "..."` | Search from the terminal, no agent involved |
| `stashwise doctor` | Check config, token validity and backend reachability. Run this first when something is off |
| `stashwise hook install` | Register the prompt hook in `~/.claude/settings.json` |
| `stashwise hook uninstall` | Remove it |
| `stashwise --version` | Print the installed version |
| `stashwise --help` | Full usage |

`hook install` registers at the user level, so it applies to every project on the machine. It pins the command to the version you installed, so npx serves it from cache rather than hitting the registry on every prompt. Rerun it after upgrading to move the pin.

```console
$ stashwise search "what did I save about HNSW indexes"

Results for "what did I save about HNSW indexes" (scope: all)

 1. Approximate Nearest Neighbors with HNSW  ·  youtube  ·  score 0.83
    A walkthrough of hierarchical navigable small world graphs and how the …
    https://youtube.com/watch?v=…

 2. pgvector HNSW tuning notes  ·  github  ·  score 0.79
    ef_search vs ef_construction trade-offs when indexing embeddings …
    https://github.com/…

2 results · 138ms
```

| `search` flag | Values | Default | Meaning |
|---|---|---|---|
| `--scope` | `library` · `wiki` · `all` | `all` | Saved items, extracted wiki entities, or both |
| `--k` | `1` to `25` | `8` | Max results |

</details>

<details>
<summary><b>The <code>search_stashwise</code> tool</b></summary>

Your agent gets exactly one tool.

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string (required) | none | Natural language search query |
| `k` | integer 1 to 25 | `8` | Max results |
| `scope` | `library` · `wiki` · `all` | `all` | What to search |

Returns ranked snippets with citations:

```json
{
  "query": "HNSW indexes",
  "retrieval_ms": 138,
  "results": [
    {
      "kind": "content",
      "id": "…",
      "title": "Approximate Nearest Neighbors with HNSW",
      "snippet": "A walkthrough of hierarchical navigable small world graphs…",
      "source_url": "https://youtube.com/watch?v=…",
      "source_platform": "youtube",
      "score": 0.83,
      "citation": "Approximate Nearest Neighbors with HNSW — youtube",
      "saved_at": "2026-05-02T11:20:00Z"
    }
  ]
}
```

`kind` is `content` for something you saved and `entity` for a concept the wiki extracted across several saves. Maps to `POST /api/v1/agent/search`.

</details>

<details>
<summary><b>Tuning the hook</b></summary>

Edit the command in `~/.claude/settings.json`:

```
stashwise hook --min-score 0.5 --k 10 --timeout-ms 4000
```

| Flag | Range | Default | Meaning |
|---|---|---|---|
| `--min-score` | 0 to 1 | `0.45` | Score a result must clear to fill a slot. Note this decides *which* results qualify, not *whether* any are shown (that is the shape gate above) |
| `--k` | 1 to 25 | `6` | Results fetched per prompt |
| `--timeout-ms` | 100 to 60000 | `2500` | How long to wait before staying silent |

Unknown flags are ignored, so a settings file written by a newer version never breaks an older binary.

</details>

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `STASHWISE_API_URL` | `https://stashwise-api.fly.dev/api/v1` | Backend base URL |
| `STASHWISE_WEB_URL` | `https://stashwise.co` | Webapp base URL, used by `auth` |
| `STASHWISE_HOOK_DEBUG` | unset | Set to `1` to log hook decisions to stderr |

Pointing at a local backend during development:

```bash
STASHWISE_API_URL=http://127.0.0.1:8000/api/v1 stashwise search "test"
```

</details>

<details>
<summary><b>Troubleshooting</b></summary>

- **"Stashwise is not authenticated."** Run `stashwise auth`. If searches worked before and suddenly stopped, the token may have been revoked from your account page; rerun `auth`.
- **The agent does not see the tool.** Restart the host after editing its config, Claude Desktop especially. In Claude Code run `/mcp` to confirm `stashwise` is connected.
- **`OS keychain unavailable …`** Expected on headless or CI Linux without libsecret. The token falls back to `~/.stashwise/credentials.json` at mode `0600` and everything still works.
- **The hook went quiet after an upgrade.** Rerun `stashwise hook install` to move the version pin. A pin naming a version that has aged out of the npx cache resolves slowly or not at all, and because the hook fails silently by design, a dead pin looks exactly like "no matches found".
- **Upgrading from 0.3.0 or earlier.** The binary was named `mcp` and is now `stashwise`. Existing hook pins are still recognized, so `hook install` migrates yours in place and `hook uninstall` still finds it. Nothing to do by hand.
- **Still stuck?** `stashwise doctor` reports config, token validity and backend reachability in one shot.

</details>

<details>
<summary><b>Managing paired machines</b></summary>

Every machine you have authorized is listed under **Account → Connect AI agents** at [stashwise.co](https://stashwise.co), where you can revoke any of them. Access is read only: the agent can search your library, never modify it.

</details>

---

## License

MIT
