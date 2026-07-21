#!/bin/sh

set -eu

marketplace_source=${STASHWISE_CODEX_MARKETPLACE_SOURCE:-StashwiseAI/stashwise-cli}
marketplace_ref=${STASHWISE_CODEX_MARKETPLACE_REF:-main}
marketplace_name=stashwise
plugin_id=stashwise@stashwise

case "$marketplace_source" in
  ./*|../*|/*) marketplace_is_local=true ;;
  *) marketplace_is_local=false ;;
esac

if ! command -v codex >/dev/null 2>&1; then
  printf '%s\n' "Codex CLI is required. Install or update Codex, then run this command again." >&2
  exit 1
fi

add_marketplace() {
  if [ "$marketplace_is_local" = true ]; then
    codex plugin marketplace add "$marketplace_source" >/dev/null
  else
    codex plugin marketplace add "$marketplace_source" --ref "$marketplace_ref" >/dev/null
  fi
}

marketplace_list=$(codex plugin marketplace list)
marketplace_root=$(printf '%s\n' "$marketplace_list" | awk '$1 == "stashwise" { print $2; exit }')

if [ -n "$marketplace_root" ]; then
  if [ "$marketplace_is_local" = false ]; then
    case "$marketplace_root" in
      */.tmp/marketplaces/stashwise)
        codex plugin marketplace upgrade "$marketplace_name" >/dev/null
        ;;
      *)
        if codex plugin marketplace remove personal --json >/dev/null 2>&1; then
          :
        elif codex plugin marketplace remove "$marketplace_name" --json >/dev/null 2>&1; then
          :
        else
          printf '%s\n' "Could not replace the legacy local Stashwise marketplace." >&2
          exit 1
        fi
        add_marketplace
        ;;
    esac
  fi
else
  add_marketplace
fi

installed_plugins=$(codex plugin list)

if printf '%s\n' "$installed_plugins" | grep -Eq '^stashwise@stashwise[[:space:]]+installed'; then
  codex plugin remove "$plugin_id" --json >/dev/null
fi

if printf '%s\n' "$installed_plugins" | grep -Eq '^stashwise@personal[[:space:]]+installed'; then
  codex plugin remove stashwise@personal --json >/dev/null
fi

install_result=$(codex plugin add "$plugin_id" --json)
plugin_version=$(printf '%s\n' "$install_result" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

if [ -n "$plugin_version" ]; then
  printf 'Stashwise %s is installed in Codex.\n' "$plugin_version"
else
  printf '%s\n' "Stashwise is installed in Codex."
fi

printf '%s\n' "Next: open /hooks in Codex and trust the Stashwise hook."
printf '%s\n' "Then start a new task so Codex loads the plugin and its tools."
