// `stashwise-mcp auth` — one-time device-code login.
//
// Flow:
//   1. POST /auth/cli/start    → get device_code + user_code + verification_uri
//   2. open(verification_uri)  → user signs in + authorizes in the webapp
//   3. poll /auth/cli/poll q2s  → returns the raw token once authorized
//   4. storeToken(raw)         → OS keychain (or ~/.stashwise/credentials.json fallback)

import { hostname, platform } from "node:os";
import openUrl from "open";
import { ApiError, StashwiseApi } from "./api.js";
import { loadConfig } from "./config.js";
import { storeToken } from "./keychain.js";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ITERATIONS = 180; // ≈6 minutes — slightly past the 5-min TTL

function defaultClientLabel(): string {
  const host = hostname() || "unknown-host";
  const plat = platform();
  return `Stashwise MCP on ${host} (${plat})`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAuth(): Promise<number> {
  const config = loadConfig();
  const api = new StashwiseApi(config);
  const clientLabel = defaultClientLabel();

  let start;
  try {
    start = await api.startDeviceCode(clientLabel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to start auth flow: ${message}\n`);
    return 1;
  }

  process.stdout.write(
    [
      "",
      `  Open this URL to authorize:`,
      ``,
      `    ${start.verification_uri}`,
      ``,
      `  Or visit ${config.webBaseUrl}/cli and enter code:`,
      ``,
      `    ${start.user_code}`,
      ``,
      "  Waiting for authorization (press Ctrl-C to cancel)...",
      "",
    ].join("\n") + "\n",
  );

  try {
    // `open()` is best-effort — if the user's environment has no browser
    // (SSH session, headless CI) the printed URL above is still the path.
    await openUrl(start.verification_uri);
  } catch {
    /* ignore — user can copy/paste the URL */
  }

  for (let i = 0; i < POLL_MAX_ITERATIONS; i++) {
    await sleep(POLL_INTERVAL_MS);
    let poll;
    try {
      poll = await api.pollDeviceCode(start.device_code);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        process.stderr.write("Pairing expired before authorization. Run `auth` again.\n");
        return 1;
      }
      // Transient network errors: keep polling — the server is the source
      // of truth for the deadline.
      continue;
    }

    if (poll.status === "expired") {
      process.stderr.write("Pairing expired. Run `auth` again.\n");
      return 1;
    }

    if (poll.status === "authorized" && poll.token) {
      await storeToken(poll.token);
      const tier = poll.user?.subscription_tier ?? "free";
      const who =
        poll.user?.email ?? poll.user?.display_name ?? "your account";
      process.stdout.write(
        `\n  Authorized as ${who} (${tier}).\n  Token stored. You can close the browser tab.\n\n`,
      );
      return 0;
    }
  }

  process.stderr.write("Timed out waiting for authorization.\n");
  return 1;
}
