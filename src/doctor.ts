// `stashwise doctor` — print configuration + token validity + backend
// reachability. Designed for the "why isn't this working?" path so users
// don't need a separate CLI binary to diagnose problems.

import { ApiError, StashwiseApi } from "./api.js";
import { STASHWISE_AUTH_COMMAND, STASHWISE_HOOK_COMMAND } from "./commands.js";
import { loadConfig } from "./config.js";
import { hookInstalledInSettings } from "./hook-install.js";
import { getStoredToken, keychainBackend } from "./keychain.js";

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

function fmt(check: CheckResult): string {
  const mark = check.ok ? "✓" : "✗";
  return `  ${mark}  ${check.label}: ${check.detail}`;
}

export async function runDoctor(): Promise<number> {
  const config = loadConfig();
  const api = new StashwiseApi(config);
  const checks: CheckResult[] = [];

  checks.push({
    label: "API base URL",
    ok: true,
    detail: config.apiBaseUrl,
  });

  // Reach the backend health endpoint. We resolve the base by stripping the
  // /api/v1 prefix because /health lives at /api/v1/health.
  let backendOk = false;
  try {
    const res = await fetch(`${config.apiBaseUrl}/health`);
    backendOk = res.ok;
    checks.push({
      label: "Backend reachable",
      ok: backendOk,
      detail: backendOk
        ? `${res.status} OK`
        : `HTTP ${res.status} ${res.statusText}`,
    });
  } catch (err) {
    checks.push({
      label: "Backend reachable",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const token = await getStoredToken();
  checks.push({
    label: "Token stored",
    ok: Boolean(token),
    detail: token
      ? `${token.slice(0, 14)}… (via ${keychainBackend()})`
      : `no token. Run \`${STASHWISE_AUTH_COMMAND}\``,
  });

  if (token && backendOk) {
    try {
      const me = await api.me(token);
      checks.push({
        label: "Token authenticates",
        ok: true,
        detail: `signed in as ${me.email ?? me.display_name ?? me.id} (${me.subscription_tier})`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        checks.push({
          label: "Token authenticates",
          ok: false,
          detail: "401: token revoked or invalid. Run `auth` again.",
        });
      } else {
        checks.push({
          label: "Token authenticates",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Informational: an uninstalled hook is a valid setup, so it never fails
  // doctor; the detail just points at the install command.
  checks.push({
    label: "Claude Code prompt hook",
    ok: true,
    detail: hookInstalledInSettings()
      ? "installed in ~/.claude/settings.json"
      : `not installed. Run \`${STASHWISE_HOOK_COMMAND} install\` for proactive suggestions`,
  });

  const allOk = checks.every((c) => c.ok);
  process.stdout.write(
    [
      "",
      `Stashwise doctor`,
      "",
      ...checks.map(fmt),
      "",
      allOk
        ? "  All good. Tool calls should work in your agent host."
        : "  Some checks failed. See notes above.",
      "",
    ].join("\n") + "\n",
  );
  return allOk ? 0 : 1;
}
