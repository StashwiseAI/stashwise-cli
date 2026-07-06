# Stashwise Obsidian Sync Plan

## Research Notes

- Obsidian community plugins are ordinary JavaScript bundles loaded from a vault plugin folder with `manifest.json`, `main.js`, and optional `styles.css`. Required manifest fields include `id`, `name`, `version`, `minAppVersion`, `description`, `author`, and `isDesktopOnly`.
- Obsidian's `Vault` API is the right write layer for plugin-created notes. It works inside the active vault and avoids direct Node filesystem assumptions.
- Obsidian's `requestUrl` API is the right HTTP layer for Stashwise API calls because it works around browser CORS constraints and is usable on mobile.
- Obsidian URI links are useful later for "open this synced note" flows from the Stashwise web app, but the plugin should not depend on URI-only writes because URI payloads are awkward for full-vault synchronization.
- The Biji Tongbu example validates the product pattern: connect with an API credential, provide a manual ribbon sync, optionally support startup/interval sync after the user enables it, let users control paths/frontmatter, and keep the data flow one-way into the local vault.
- The evergreen/personal-wiki model points toward concept-level notes, not one big export. Stashwise wiki entities should become stable Obsidian topic notes with links to related topics and source evidence.

## Product Shape

Stashwise remains the cloud capture and extraction engine. Obsidian becomes the user's local durable knowledge store. The sync direction is one-way:

```text
Saved content -> Stashwise extraction -> published Stashwise wiki topics -> Obsidian plugin -> local Markdown vault
```

This avoids needing to interpret arbitrary local note edits or upload the user's existing vault. The plugin only writes under the configured Stashwise folder.

## Vault Structure

```text
Stashwise/
  Home.md
  Graph.md
  Topics/
    <topic>.md
```

Each topic note includes:

- YAML frontmatter with `stashwise_id`, `stashwise_type`, `stashwise_updated_at`, `category`, `canonical_form`, and `mention_count`.
- A synthesized Stashwise summary.
- Wikilinks to related Stashwise topics.
- Optional claims, open contradictions, and supporting snippets.
- Optional source links, context snippets, platform, confidence, and personal notes.

## Current Implementation

The first plugin implementation lives in this folder and currently supports:

- Device-code auth through existing Stashwise CLI endpoints.
- Manual sync command and ribbon button.
- Manual sync after account connection, with optional startup/interval sync off by default.
- Published-topic sync (`quality=published`) so raw extraction candidates do not become local notes.
- Progress reporting for list fetching, local freshness checks, topic updates, deletion, and index refreshes.
- Paginated `/wiki/pages` sync plus per-topic `/wiki/pages/{entity_id}` detail fetches.
- Local Markdown writes through Obsidian `Vault`.
- Stable file paths remembered in plugin data to avoid breaking links.
- `Home.md` and optional `Graph.md` index files.
- Mobile compatibility (`isDesktopOnly: false`, no Node filesystem APIs).

## Backend Gaps To Close Next

The existing API is enough for a usable MVP, but a production sync should add a dedicated endpoint set:

- `GET /api/v1/wiki/sync/manifest?since=<timestamp>` returning changed IDs, deleted IDs, current version, and page hashes.
- `GET /api/v1/wiki/sync/pages/{entity_id}` returning a Markdown-ready payload or canonical Markdown rendered server-side.
- Token scopes/names that distinguish Obsidian sync tokens from MCP agent tokens.
- Optional ETag/hash support so the plugin can avoid fetching unchanged page detail.
- Optional media export policy for thumbnails/images that should be copied into the vault instead of linked remotely.

## Release Path

1. Manual beta: build `main.js`, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/stashwise-sync/`.
2. Internal TestFlight-style beta: publish a GitHub release and install with BRAT.
3. Community plugin: submit to Obsidian after security/privacy copy, token handling, mobile smoke tests, and settings polish are done.
