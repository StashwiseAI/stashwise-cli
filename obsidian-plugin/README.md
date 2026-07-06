# Stashwise Sync for Obsidian

This plugin syncs a Stashwise account's wiki into local Markdown notes inside an Obsidian vault.

## Development

```sh
npm install
npm run build
```

For manual testing in this workspace vault:

```sh
npm run install:local
```

To install into another vault:

```sh
STASHWISE_OBSIDIAN_VAULT="/path/to/vault" npm run install:local
```

The helper copies `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/stashwise-sync/
```

Then reload Obsidian and enable **Stashwise Sync** in Community plugins if it is not already enabled.

## Local Customer Flow

1. Open Obsidian to the test vault.
2. Go to **Settings -> Community plugins -> Installed plugins** and confirm **Stashwise Sync** is enabled.
3. Go to **Settings -> Stashwise Sync**.
4. Click **Connect**.
5. Stashwise opens in the browser for login/authorization while Obsidian shows the pairing code.
6. Approve the connection in Stashwise.
7. Return to Obsidian. The account is connected, but no import starts yet.
8. Click **Sync** when you are ready to copy the published wiki topics into the vault. The settings page shows progress, elapsed time, and an estimated remaining time while it runs.
9. Open `Stashwise/Home.md`.

## Current Scope

- Device-code login through the existing Stashwise CLI auth endpoints.
- One-way Stashwise-to-Obsidian sync.
- Local Markdown notes for published Stashwise wiki topics under `Stashwise/Topics`.
- A `Stashwise/Home.md` index and optional `Stashwise/Graph.md` relationship note.
- Mobile-compatible HTTP through Obsidian `requestUrl`.

Edits made inside Obsidian are not sent back to Stashwise.
