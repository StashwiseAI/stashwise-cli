---
name: search-stashwise
description: Use the connected user's private Stashwise library and wiki to ground answers, retrieve recent saves, preserve research, and organize saved items.
---

# Stashwise

Stashwise is the user's private research library. Treat its results as user-provided sources, not as general web knowledge.

## Retrieval

- Search Stashwise before answering when the topic is something the user plausibly saved, even if they did not name Stashwise.
- Always search when the user says “my library,” “my saves,” “what I saved,” or explicitly mentions Stashwise.
- Use `get_recent_stashwise` for date-oriented requests instead of forcing dates into semantic search.
- If the first search was based on a broad or raw prompt and looks incomplete, search again with a query refined to the user's actual intent.
- Use `get_stashwise_item` when an answer needs details beyond a search snippet.
- Stay quiet about irrelevant matches. Do not bend the answer around a result merely because it was returned.

## Grounding

- Cite a returned `source_url` when a saved source informs the answer.
- Clearly distinguish what the user's library says from your own reasoning or current web research.
- Never claim a source supports details absent from its returned snippet or item body.
- Do not expose similarity scores unless the user asks about retrieval quality.

## Writes

- Call `save_to_stashwise`, `create_stashwise_note`, or `update_stashwise_item` only when the user asks to save, preserve, annotate, or organize something, or their intent is otherwise explicit.
- Preserve useful source links in research notes. Prefer concise summaries and descriptive tags.
- List categories before assigning a category when its id is not already known.
- Never imply that Stashwise can delete content through this integration; deletion is intentionally unavailable.

## Failures

- If authorization is missing or expired, tell the user to reconnect the Stashwise plugin.
- If a quota blocks a save, explain the returned limit once and continue without retrying.
- Never include tokens, authorization codes, or private library contents in diagnostics.

