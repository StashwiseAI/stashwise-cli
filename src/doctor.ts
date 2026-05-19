// `stashwise-mcp doctor` — print configuration + token validity + backend
// reachability. Designed for the "why isn't this working?" path so users
// don't need a separate CLI binary to diagnose problems.

import { ApiError, StashwiseApi } from "./api.js";
import { loadConfig } from "./config.js";
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
      : "no token — run `npx -y @stashwise/mcp auth`",
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
          detail: "401 — token revoked or invalid. Run `auth` again.",
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

  const allOk = checks.every((c) => c.ok);
  process.stdout.write(
    [
      "",
      `Stashwise MCP — doctor`,
      "",
      ...checks.map(fmt),
      "",
      allOk
        ? "  All good. Tool calls should work in your agent host."
        : "  Some checks failed — see notes above.",
      "",
    ].join("\n") + "\n",
  );
  return allOk ? 0 : 1;
}
