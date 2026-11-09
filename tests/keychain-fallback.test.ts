import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("keytar", () => {
  throw new Error("no libsecret");
});

const {
  deleteStoredToken,
  getStoredToken,
  getWalletClaimCredential,
  getWalletToken,
  storeToken,
  storeWalletCredentials,
} = await import("../src/keychain.js");

const API = "http://api.test/api/v1";
const ADDRESS = "0xABCDEF0000000000000000000000000000000000";

describe("file fallback keeps the human token and wallet credentials apart", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "stashwise-keychain-"));
    vi.stubEnv("HOME", home);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it("does not clobber either when the other is written", async () => {
    await storeToken("human");
    await storeWalletCredentials(API, ADDRESS, { token: "agent", claimCredential: "claim" });
    expect(await getStoredToken()).toBe("human");
    expect(await getWalletToken(API, ADDRESS)).toBe("agent");
    await storeToken("human2");
    expect(await getWalletClaimCredential(API, ADDRESS)).toBe("claim");
    expect(statSync(join(home, ".stashwise", "credentials.json")).mode & 0o777).toBe(0o600);
  });

  it("logging out keeps the wallet's credentials", async () => {
    await storeToken("human");
    await storeWalletCredentials(API, ADDRESS, { token: "agent", claimCredential: "claim" });
    await deleteStoredToken();
    expect(await getStoredToken()).toBeNull();
    expect(await getWalletToken(API, ADDRESS)).toBe("agent");
    expect(readFileSync(join(home, ".stashwise", "credentials.json"), "utf-8")).not.toContain("human");
  });

  it("scopes wallet credentials to the backend", async () => {
    await storeWalletCredentials(API, ADDRESS, { token: "agent", claimCredential: null });
    expect(await getWalletToken("http://other.test/api/v1", ADDRESS)).toBeNull();
    expect(await getWalletClaimCredential(API, ADDRESS)).toBeNull();
  });
});
