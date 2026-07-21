# Changelog

All notable changes to `@stashwiseapp/mcp`.

## 0.4.1

### `hook install` and `doctor` now prove the pinned command actually runs

Writing a pin is not the same as writing one that works, and the difference was
invisible. The hook exits 0 on failure by design, so it can never block a
prompt; the cost is that a hook which cannot start looks exactly like a hook
that found nothing.

That is not hypothetical. During the 0.4.0 release the pinned command returned
`command not found` on and off for roughly an hour, while the same package
resolved fine through other specs. Nothing surfaced it. The hook simply went
quiet, which is its correct behavior for "no matches".

- `hook install` now executes the command it just wrote and fails loudly if it
  does not resolve, rather than reporting success and leaving you to discover
  the silence later.
- `doctor` gained a **Pinned hook command runs** check against whatever is
  currently in settings, and flags a stale pin whose version no longer matches
  what it reports. This check found the broken state on its first run.

### Hardening: the pinned command is isolated from the surrounding project

`npm exec` resolves against the current project before its own cache, and the
hook runs with cwd set to wherever the agent happens to be. The command now
passes `--prefix ~/.stashwise` so resolution does not depend on the contents of
that directory.

To be straight about this one: it is defensive, not a fix for a reproduced bug.
The intermittent failures above correlated with cwd in early testing, but that
did not hold up under a cold cache, and the true cause was never pinned down.
`--prefix` removes one real variable at no cost. The detection above is what
actually protects you.

**Run `stashwise hook install` to repin.** Existing pins are recognized and
rewritten in place.

---

## 0.4.0

### Breaking: the binary is now `stashwise`

It was `mcp`. That is far too generic a name to occupy on a global PATH, which
is why a global install could never be recommended and every documented command
had to carry a 48 character `npx` prefix.

```bash
npm i -g @stashwiseapp/mcp
stashwise auth
```

**If you use the prompt hook, there is nothing to do.** Existing pins naming the
old binary are still recognized, so `stashwise hook install` rewrites yours in
place and `stashwise hook uninstall` still finds it.

**If your MCP config names the binary explicitly, update it.** A config reading
`npx -y --package @stashwiseapp/mcp@latest mcp` refers to a binary that no
longer exists and will fail to start. Either of these works:

```jsonc
{ "command": "stashwise" }                                                   // global install
{ "command": "npx", "args": ["-y", "--package", "@stashwiseapp/mcp@latest", "stashwise"] }
```

Configs written as `npx -y @stashwiseapp/mcp@latest`, with no binary named, are
unaffected: npm runs the package's sole binary regardless of its name.

### The agent now searches on its own initiative

The `search_stashwise` tool description now tells the agent to search when you
ask about something you plausibly saved, and to search again with a better query
when a surfaced suggestion looks incomplete.

This closes a gap in 0.3.0. That release added the same invitation, but placed it
inside the hook's suggestion block, so it was delivered only when the hook had
already found something. On a silent prompt, the exact case it was written for,
nothing was emitted and the instruction never arrived. The tool description is
unconditional, costs nothing per prompt, and applies in Cursor and Codex too.

### Documentation

The README is rewritten around what the tool does rather than how to configure
it. It now opens with a real transcript, and adds two sections it never had:
measured latency and data egress (a hook that runs on every prompt should say
what it costs), and an accurate description of when it stays quiet.

---

## 0.3.0

### Suggestions are gated on distribution shape, not an absolute score

Previously a result was suggested when it cleared a fixed threshold. That cannot
separate a real match from a vague one, because similarity scores are not
comparable between questions: a broad prompt lands near the centre of a topic
cluster and scores respectably against a dozen mediocre items, while a narrow one
lands somewhere sparse and scores poorly against the single item that answers it.
Any fixed floor is simultaneously too low for the first and too high for the
second.

The hook now asks whether one result stands out from the rest. A flat pack stays
silent no matter how high it scores. Measured against six labeled probes, the
three that should stay quiet separated cleanly from the three that should fire.

In practice: noticeably fewer irrelevant suggestions on broad questions, and no
change to the ones that were already useful.

### Suggestions are shown to you directly

The hook emits on two channels: `systemMessage`, which the harness always
displays, and `additionalContext`, which reaches the model. Earlier versions used
one channel and depended on the model to relay what was found, which it often did
not when a loaded skill dominated the answer.

### Also

- Results with no readable summary are dropped rather than shown as a bare title.
- `scripts/calibrate-gating.mjs` replays labeled probes against your live library
  so the gating constants stay answerable to data.

---

## 0.2.2 and earlier

Initial releases: stdio MCP server exposing `search_stashwise`, device-code
`auth` with OS keychain storage, terminal `search`, `doctor`, and the Claude Code
`UserPromptSubmit` hook.
