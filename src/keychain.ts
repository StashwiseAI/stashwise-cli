// OS keychain wrapper with a graceful filesystem fallback.
//
// `keytar` covers macOS (Security framework), Windows (Credential Vault),
// and Linux (libsecret via the secret-tool service). When keytar isn't
// available (CI, some headless Linux setups), we fall back to writing
// `~/.stashwise/credentials.json` with 0600 perms. The fallback is
// announced loudly to stderr so users know what happened.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE = "co.stashwise.mcp";
const ACCOUNT_DEFAULT = "default";

interface KeytarLike {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (
    service: string,
    account: string,
    password: string,
  ) => Promise<void>;
  deletePassword: (
    service: string,
    account: string,
  ) => Promise<boolean>;
}

let keytarModule: KeytarLike | null | undefined = undefined;

async function tryLoadKeytar(): Promise<KeytarLike | null> {
  if (keytarModule !== undefined) return keytarModule;
  try {
    // Optional native dep. Some install environments don't have a working
    // libsecret-1 — fail soft rather than aborting auth.
    const mod = (await import("keytar")) as unknown as KeytarLike & {
      default?: KeytarLike;
    };
    keytarModule = mod.default ?? mod;
    return keytarModule;
  } catch (err) {
    process.stderr.write(
      `[stashwise-mcp] OS keychain unavailable, falling back to ~/.stashwise/credentials.json (${
        err instanceof Error ? err.message : String(err)
      })\n`,
    );
    keytarModule = null;
    return null;
  }
}

function fallbackPath(): string {
  return join(homedir(), ".stashwise", "credentials.json");
}

async function readFallback(): Promise<string | null> {
  try {
    const raw = await fs.readFile(fallbackPath(), "utf-8");
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed.token ?? null;
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

async function writeFallback(token: string): Promise<void> {
  const path = fallbackPath();
  await fs.mkdir(join(homedir(), ".stashwise"), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ token }), { mode: 0o600 });
}

async function deleteFallback(): Promise<void> {
  try {
    await fs.unlink(fallbackPath());
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

export async function getStoredToken(): Promise<string | null> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    return keytar.getPassword(SERVICE, ACCOUNT_DEFAULT);
  }
  return readFallback();
}

export async function storeToken(token: string): Promise<void> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE, ACCOUNT_DEFAULT, token);
    return;
  }
  await writeFallback(token);
}

export async function deleteStoredToken(): Promise<boolean> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    return keytar.deletePassword(SERVICE, ACCOUNT_DEFAULT);
  }
  await deleteFallback();
  return true;
}

export function keychainBackend(): "keytar" | "file" | "unknown" {
  if (keytarModule === undefined) return "unknown";
  return keytarModule ? "keytar" : "file";
}
