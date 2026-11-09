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

interface FallbackFile {
  token?: string;
  secrets?: Record<string, string>;
}

async function readFallbackFile(): Promise<FallbackFile | null> {
  try {
    const raw = await fs.readFile(fallbackPath(), "utf-8");
    return JSON.parse(raw) as FallbackFile;
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

async function writeFallbackFile(contents: FallbackFile): Promise<void> {
  const path = fallbackPath();
  await fs.mkdir(join(homedir(), ".stashwise"), { recursive: true });
  await fs.writeFile(path, JSON.stringify(contents), { mode: 0o600 });
}

async function readFallback(): Promise<string | null> {
  return (await readFallbackFile())?.token ?? null;
}

async function writeFallback(token: string): Promise<void> {
  await writeFallbackFile({ ...(await readFallbackFile()), token });
}

async function deleteFallback(): Promise<void> {
  const existing = await readFallbackFile();
  if (!existing) return;
  if (existing.secrets && Object.keys(existing.secrets).length > 0) {
    await writeFallbackFile({ secrets: existing.secrets });
    return;
  }
  await fs.unlink(fallbackPath());
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

// Wallet credentials. Scoped to the backend as well as the address, because
// the same address on two backends or networks is two separate accounts.

function walletAccount(
  apiBaseUrl: string,
  address: string,
  kind: "token" | "claim",
): string {
  return `wallet:${apiBaseUrl}:${address.toLowerCase()}:${kind}`;
}

async function getSecret(account: string): Promise<string | null> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    return keytar.getPassword(SERVICE, account);
  }
  return (await readFallbackFile())?.secrets?.[account] ?? null;
}

async function setSecret(account: string, value: string | null): Promise<void> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    if (value === null) {
      await keytar.deletePassword(SERVICE, account);
    } else {
      await keytar.setPassword(SERVICE, account, value);
    }
    return;
  }
  const existing = (await readFallbackFile()) ?? {};
  const secrets = { ...existing.secrets };
  if (value === null) {
    delete secrets[account];
  } else {
    secrets[account] = value;
  }
  await writeFallbackFile({ ...existing, secrets });
}

export function getWalletToken(
  apiBaseUrl: string,
  address: string,
): Promise<string | null> {
  return getSecret(walletAccount(apiBaseUrl, address, "token"));
}

export function getWalletClaimCredential(
  apiBaseUrl: string,
  address: string,
): Promise<string | null> {
  return getSecret(walletAccount(apiBaseUrl, address, "claim"));
}

/** A null claim credential clears the stored one: the wallet has been claimed. */
export async function storeWalletCredentials(
  apiBaseUrl: string,
  address: string,
  credentials: { token: string; claimCredential: string | null },
): Promise<void> {
  await setSecret(walletAccount(apiBaseUrl, address, "token"), credentials.token);
  await setSecret(
    walletAccount(apiBaseUrl, address, "claim"),
    credentials.claimCredential,
  );
}

export function keychainBackend(): "keytar" | "file" | "unknown" {
  if (keytarModule === undefined) return "unknown";
  return keytarModule ? "keytar" : "file";
}
