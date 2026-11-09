import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";

const keychain = vi.hoisted(() => new Map<string, string>());

vi.mock("keytar", () => ({
  default: {
    getPassword: async (_s: string, a: string) => keychain.get(a) ?? null,
    setPassword: async (_s: string, a: string, v: string) => void keychain.set(a, v),
    deletePassword: async (_s: string, a: string) => keychain.delete(a),
  },
}));

const { ApiError, StashwiseApi } = await import("../src/api.js");
const { getWalletClaimCredential, getWalletToken } = await import("../src/keychain.js");
const { runDoctor } = await import("../src/doctor.js");
const { TOOL_DEFINITIONS, toolsFor } = await import("../src/serve.js");
const { spentTodayFor } = await import("../src/spend-ledger.js");
const {
  atomicToUsd,
  formatSiweMessage,
  loadWallet,
  PaymentOutcomeUnknownError,
  PaymentRefusedError,
  usdToAtomic,
  WalletCapError,
  WalletConfigError,
} = await import("../src/wallet.js");
const { callPaidTool, runWallet } = await import("../src/wallet-tools.js");
type Wallet = import("../src/wallet.js").Wallet;

const SEPOLIA = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const URL_BODY = { source_url: "https://example.com/a" };
const AGENT_TOKEN = "sw_at_secret_agent_token";
const CLAIM = "PUBLICID1234.SECRETSECRET";

const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  destroy?: boolean;
};

let server: Server;
let base: string;
let seen: Seen[];
let replies: Reply[];
let home: string;

function requirements(over: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: SEPOLIA,
    asset: USDC,
    amount: "80000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...over,
  };
}

function challenge(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  const required = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: `${base}/x402/saves` },
    accepts: [requirements(over)],
    extensions: {
      "payment-identifier": { info: { required: true }, schema: { type: "object" } },
    },
    ...top,
  };
  return {
    status: 402,
    body: required,
    headers: {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64"),
    },
  };
}

function saved(over: Record<string, unknown> = {}): Reply {
  return {
    status: 201,
    body: {
      content: { id: "c1", status: "pending" },
      payment: { id: "p1", status: "settled" },
      credit: null,
      account: { user_id: "u1", created: false, agent_token: null, claim: null },
      ...over,
    },
  };
}

const firstContact = {
  account: {
    user_id: "u1",
    created: true,
    agent_token: AGENT_TOKEN,
    claim: { credential: CLAIM, url: `https://stashwise.co/claim?code=${CLAIM}` },
  },
};

async function wallet(env: Record<string, string> = {}): Promise<Wallet> {
  const state = await loadWallet({
    STASHWISE_WALLET_PRIVATE_KEY: key,
    STASHWISE_WALLET_MAX_PER_CALL_USD: "0.30",
    STASHWISE_WALLET_MAX_PER_DAY_USD: "1.00",
    ...env,
  });
  if (state.status !== "ready") throw new Error("wallet not ready");
  return state.wallet;
}

function api() {
  return new StashwiseApi({ apiBaseUrl: base, webBaseUrl: "http://web.test" });
}

function config() {
  return { apiBaseUrl: base, webBaseUrl: "http://web.test" };
}

function signedPayment(request: Seen) {
  const header = request.headers["payment-signature"];
  expect(typeof header).toBe("string");
  return JSON.parse(Buffer.from(String(header), "base64").toString("utf-8"));
}

beforeEach(async () => {
  keychain.clear();
  seen = [];
  replies = [];
  home = mkdtempSync(join(tmpdir(), "stashwise-wallet-"));
  vi.stubEnv("HOME", home);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const reply = replies.shift() ?? { status: 500, body: { detail: "no reply queued" } };
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

describe("wallet configuration", () => {
  it("is absent without a key, and the tool list is unchanged", async () => {
    const state = await loadWallet({});
    expect(state).toEqual({ status: "absent" });
    expect(toolsFor(state)).toBe(TOOL_DEFINITIONS);
    expect(TOOL_DEFINITIONS.map((t) => t.name)).not.toContain("save_to_stashwise");
  });

  it("adds both paid tools when a wallet is set", async () => {
    const names = toolsFor({ status: "ready", wallet: await wallet() }).map((t) => t.name);
    expect(names).toContain("save_to_stashwise");
    expect(names).toContain("create_stashwise_note");
  });

  it("never repeats a bad key in its error", async () => {
    const bad = `0x${"z".repeat(64)}`;
    const state = await loadWallet({ STASHWISE_WALLET_PRIVATE_KEY: bad });
    expect(state.status).toBe("invalid");
    expect(JSON.stringify(state)).not.toContain(bad);
  });

  it("keeps the key off the wallet object", async () => {
    const w = await wallet();
    expect(inspect(w, { depth: 8, showHidden: true })).not.toContain(key.slice(2));
  });

  it.each([
    [{ STASHWISE_WALLET_MAX_PER_CALL_USD: "" }],
    [{ STASHWISE_WALLET_MAX_PER_DAY_USD: "" }],
    [{ STASHWISE_WALLET_MAX_PER_DAY_USD: "lots" }],
    [{ STASHWISE_WALLET_MAX_PER_CALL_USD: "0" }],
    [{ STASHWISE_WALLET_MAX_PER_CALL_USD: "1e3" }],
  ])("signs nothing with missing or bad caps %j", async (env) => {
    const w = await wallet(env);
    expect(w.caps).toBeNull();
    replies.push(challenge());
    await expect(api().paidSave(w, null, URL_BODY)).rejects.toBeInstanceOf(WalletConfigError);
    expect(seen).toHaveLength(1);
  });

  it("converts dollars exactly", () => {
    expect(usdToAtomic("0.08")).toBe(80000n);
    expect(usdToAtomic("12")).toBe(12000000n);
    expect(usdToAtomic("0.000001")).toBe(1n);
    expect(() => usdToAtomic("0.0000001")).toThrow(WalletConfigError);
    expect(() => usdToAtomic("-1")).toThrow(WalletConfigError);
    expect(atomicToUsd(80000n)).toBe("0.08");
    expect(atomicToUsd(300000n)).toBe("0.30");
    expect(atomicToUsd(1000000n)).toBe("1.00");
  });
});

describe("paying a 402", () => {
  it("signs EIP-3009 and retries exactly once with an identifier", async () => {
    replies.push(challenge(), saved());
    const before = Math.floor(Date.now() / 1000);
    const result = await api().paidSave(await wallet(), null, URL_BODY);
    expect(result.payment).toEqual({ id: "p1", status: "settled" });
    expect(seen).toHaveLength(2);
    expect(seen[0].headers["payment-signature"]).toBeUndefined();
    expect(seen[1].url).toBe("/api/v1/x402/saves");
    expect(JSON.parse(seen[1].body)).toEqual(URL_BODY);

    const payment = signedPayment(seen[1]);
    const auth = payment.payload.authorization;
    expect(payment.x402Version).toBe(2);
    expect(payment.accepted).toEqual(requirements());
    expect(auth.from).toBe(address.toLowerCase());
    expect(auth.to).toBe(PAY_TO.toLowerCase());
    expect(auth.value).toBe("80000");
    expect(auth.validAfter).toBe("0");
    expect(Number(auth.validBefore)).toBeGreaterThanOrEqual(before + 300);
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(before + 302);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const id = payment.extensions["payment-identifier"].info.id;
    expect(id).toMatch(/^pay_[0-9a-f]{32}$/);
    expect(payment.extensions["payment-identifier"].info.required).toBe(true);

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "USDC",
        version: "2",
        chainId: 84532,
        verifyingContract: USDC,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: 80000n,
        validAfter: 0n,
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: payment.payload.signature,
    });
    expect(recovered).toBe(address);
    expect(await spentTodayFor(address)).toBe(80000n);
  });

  it("uses mainnet's own domain name", async () => {
    replies.push(
      challenge({
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: { name: "USD Coin", version: "2" },
      }),
      saved(),
    );
    await api().paidSave(await wallet(), null, URL_BODY);
    expect(signedPayment(seen[1]).accepted.network).toBe("eip155:8453");
  });

  it("gives each payment its own nonce and identifier", async () => {
    replies.push(challenge(), saved(), challenge(), saved());
    const w = await wallet();
    await api().paidSave(w, null, URL_BODY);
    await api().paidSave(w, null, URL_BODY);
    const [a, b] = [signedPayment(seen[1]), signedPayment(seen[3])];
    expect(a.payload.authorization.nonce).not.toBe(b.payload.authorization.nonce);
    expect(a.extensions["payment-identifier"].info.id).not.toBe(
      b.extensions["payment-identifier"].info.id,
    );
  });

  it("caps how long an authorization lives", async () => {
    replies.push(challenge({ maxTimeoutSeconds: 99999 }), saved());
    const before = Math.floor(Date.now() / 1000);
    await api().paidSave(await wallet(), null, URL_BODY);
    const auth = signedPayment(seen[1]).payload.authorization;
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(before + 602);
  });

  it.each([
    ["an unknown asset", { asset: PAY_TO }],
    ["an unknown network", { network: "eip155:1" }],
    ["another scheme", { scheme: "upto" }],
    ["a spoofed token name", { extra: { name: "Evil", version: "2" } }],
    ["a bad amount", { amount: "0" }],
    ["a bad pay to", { payTo: "nobody" }],
  ])("signs nothing for %s", async (_label, over) => {
    replies.push(challenge(over));
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toBeInstanceOf(
      PaymentRefusedError,
    );
    expect(seen).toHaveLength(1);
    expect(await spentTodayFor(address)).toBe(0n);
  });

  it("signs nothing when identifiers are not declared", async () => {
    replies.push(challenge({}, { extensions: {} }));
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toThrow(
      /payment identifiers/,
    );
    expect(seen).toHaveLength(1);
  });

  it("signs nothing for an unreadable challenge", async () => {
    replies.push({ status: 402, body: {}, headers: { "PAYMENT-REQUIRED": "not json" } });
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toBeInstanceOf(
      PaymentRefusedError,
    );
    expect(seen).toHaveLength(1);
  });

  it("leaves a 402 with no x402 terms alone", async () => {
    replies.push({ status: 402, body: { code: "limit_exceeded" } });
    const failure = await api().paidSave(await wallet(), null, URL_BODY).catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(402);
    expect(seen).toHaveLength(1);
  });

  it("never pays on a request that was not given a wallet", async () => {
    replies.push(challenge());
    await expect(api().me("token")).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveLength(1);
  });

  it("spends a credit without signing", async () => {
    replies.push(saved({ payment: null, credit: { id: "k1", status: "consumed" } }));
    const result = await api().paidSave(await wallet(), "sw_at_x", URL_BODY);
    expect(result.credit).toEqual({ id: "k1", status: "consumed" });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe("Bearer sw_at_x");
    expect(await spentTodayFor(address)).toBe(0n);
  });
});

describe("caps", () => {
  it("refuses above the per call cap before signing", async () => {
    replies.push(challenge({ amount: "300001" }));
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toThrow(
      /per call cap of \$0\.30/,
    );
    expect(seen).toHaveLength(1);
    expect(await spentTodayFor(address)).toBe(0n);
  });

  it("allows exactly the cap", async () => {
    replies.push(challenge({ amount: "300000" }), saved());
    await api().paidSave(await wallet(), null, URL_BODY);
    expect(seen).toHaveLength(2);
  });

  it("refuses past the daily cap", async () => {
    const w = await wallet({ STASHWISE_WALLET_MAX_PER_DAY_USD: "0.10" });
    replies.push(challenge(), saved(), challenge());
    await api().paidSave(w, null, URL_BODY);
    const failure = await api().paidSave(w, null, URL_BODY).catch((e) => e);
    expect(failure).toBeInstanceOf(WalletCapError);
    expect(failure.message).toContain("daily cap of $0.10");
    expect(seen).toHaveLength(3);
  });

  it("holds the daily cap under concurrent calls", async () => {
    const w = await wallet({ STASHWISE_WALLET_MAX_PER_DAY_USD: "0.16" });
    for (let i = 0; i < 5; i++) replies.push(challenge());
    const header = challenge().headers["PAYMENT-REQUIRED"];
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => w.prepare(header)),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(2);
    expect(await spentTodayFor(address)).toBe(160000n);
  });

  it("starts a new total on a new UTC day", async () => {
    const dir = join(home, ".stashwise");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "x402-spend.json"),
      JSON.stringify({ [address.toLowerCase()]: { day: "2000-01-01", spent: "900000" } }),
    );
    const w = await wallet({ STASHWISE_WALLET_MAX_PER_DAY_USD: "0.10" });
    replies.push(challenge(), saved());
    await api().paidSave(w, null, URL_BODY);
    expect(await spentTodayFor(address)).toBe(80000n);
  });

  it("refuses rather than resets when the ledger is corrupt", async () => {
    const dir = join(home, ".stashwise");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x402-spend.json"), "{broken");
    replies.push(challenge());
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toThrow(
      /unreadable/,
    );
    expect(seen).toHaveLength(1);
    expect(readFileSync(join(dir, "x402-spend.json"), "utf-8")).toBe("{broken");
  });

  it.each([
    ["a duplicate", { status: 200, body: { content: { id: "c" }, payment: null } }],
    ["a conflict", { status: 409, body: { code: "payment_identifier_conflict" } }],
    ["a rate limit", { status: 429, body: { code: "wallet_concurrency_limit" } }],
  ])("gives the amount back for %s", async (_label, reply) => {
    replies.push(challenge(), reply);
    await api().paidSave(await wallet(), null, URL_BODY).catch(() => undefined);
    expect(await spentTodayFor(address)).toBe(0n);
  });

  it("gives the amount back when the retry is refused, and does not pay again", async () => {
    replies.push(challenge(), challenge({}, { error: "Payment settlement failed: x" }));
    const failure = await api().paidSave(await wallet(), null, URL_BODY).catch((e) => e);
    expect(failure).toBeInstanceOf(PaymentRefusedError);
    expect(failure.message).toContain("Payment settlement failed");
    expect(seen).toHaveLength(2);
    expect(await spentTodayFor(address)).toBe(0n);
  });

  it("keeps a settlement_unknown 202 counted", async () => {
    replies.push(challenge(), { status: 202, body: { payment: { status: "settlement_unknown" } } });
    const result = await api().paidSave(await wallet(), null, URL_BODY);
    expect(result.payment).toEqual({ status: "settlement_unknown" });
    expect(await spentTodayFor(address)).toBe(80000n);
  });

  it("keeps a server error counted and says the outcome is unknown", async () => {
    replies.push(challenge(), { status: 500, body: {} });
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );
    expect(await spentTodayFor(address)).toBe(80000n);
  });

  it("keeps a lost response counted and never resends", async () => {
    replies.push(challenge(), { status: 0, destroy: true });
    await expect(api().paidSave(await wallet(), null, URL_BODY)).rejects.toBeInstanceOf(
      PaymentOutcomeUnknownError,
    );
    expect(seen).toHaveLength(2);
    expect(await spentTodayFor(address)).toBe(80000n);
  });
});

describe("paid tools", () => {
  async function ready() {
    return { status: "ready" as const, wallet: await wallet() };
  }

  it("stores first contact credentials and shows the claim link once", async () => {
    replies.push(challenge(), saved(firstContact));
    const result = await callPaidTool(api(), config(), await ready(), "save_to_stashwise", URL_BODY);
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    const view = JSON.parse(text);
    expect(view.claim_url).toBe(firstContact.account.claim.url);
    expect(view.account).toEqual({ user_id: "u1", created: true });
    expect(text).not.toContain(AGENT_TOKEN);
    expect(text).not.toContain('"credential"');
    expect(await getWalletToken(base, address)).toBe(AGENT_TOKEN);
    expect(await getWalletClaimCredential(base, address)).toBe(CLAIM);

    replies.push(challenge(), saved());
    const second = await callPaidTool(api(), config(), await ready(), "save_to_stashwise", URL_BODY);
    expect(second.content[0].text).not.toContain("claim_url");
    expect(second.content[0].text).not.toContain(CLAIM);
    expect(seen[2].headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(await getWalletClaimCredential(base, address)).toBe(CLAIM);
  });

  it("posts notes to the notes route", async () => {
    replies.push(challenge(), saved());
    const result = await callPaidTool(api(), config(), await ready(), "create_stashwise_note", {
      title: "T",
      body: "B",
    });
    expect(result.isError).toBeUndefined();
    expect(seen[0].url).toBe("/api/v1/x402/notes");
    expect(JSON.parse(seen[1].body)).toEqual({ title: "T", body: "B" });
  });

  it("works with no signed in Stashwise user", async () => {
    replies.push(challenge(), saved());
    await callPaidTool(api(), config(), await ready(), "save_to_stashwise", URL_BODY);
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it("warns, without losing the claim link, when the keychain fails", async () => {
    const original = keychain.set.bind(keychain);
    keychain.set = () => {
      throw new Error("locked");
    };
    try {
      replies.push(challenge(), saved(firstContact));
      const result = await callPaidTool(api(), config(), await ready(), "save_to_stashwise", URL_BODY);
      const view = JSON.parse(result.content[0].text);
      expect(view.claim_url).toBeTruthy();
      expect(view.credentials_warning).toContain("wallet recover");
      expect(result.content[0].text).not.toContain(AGENT_TOKEN);
    } finally {
      keychain.set = original;
    }
  });

  it("reports caps as a tool error", async () => {
    replies.push(challenge({ amount: "900000" }));
    const result = await callPaidTool(api(), config(), await ready(), "save_to_stashwise", URL_BODY);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("per call cap");
  });

  it("points a rejected token at recovery", async () => {
    replies.push({ status: 401, body: { detail: "bad" } });
    const result = await callPaidTool(api(), config(), await ready(), "save_to_stashwise", URL_BODY);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("wallet recover");
  });

  it("rejects bad arguments before any request", async () => {
    const result = await callPaidTool(api(), config(), await ready(), "save_to_stashwise", {});
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("explains an unusable key without repeating it", async () => {
    const result = await callPaidTool(
      api(),
      config(),
      { status: "invalid", problem: "bad key" },
      "save_to_stashwise",
      URL_BODY,
    );
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("wallet recover", () => {
  function recoveryChallenge(host: string, over: Record<string, unknown> = {}): Reply {
    return {
      status: 402,
      body: {
        accepts: [],
        extensions: {
          "sign-in-with-x": {
            info: {
              domain: host,
              uri: `http://${host}/api/v1/x402/account/recover`,
              version: "1",
              nonce: "abc123",
              issuedAt: "2026-11-09T00:00:00Z",
              expirationTime: "2026-11-09T00:10:00Z",
              statement: "Recover your Stashwise wallet account",
              resources: [`http://${host}/api/v1/x402/account/recover`],
              ...over,
            },
            supportedChains: [{ chainId: SEPOLIA, type: "eip191" }],
          },
        },
      },
    };
  }

  function capture() {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    return () => out;
  }

  function env() {
    vi.stubEnv("STASHWISE_API_URL", base);
    vi.stubEnv("STASHWISE_WALLET_PRIVATE_KEY", key);
  }

  it("proves control, stores the new credentials and shows only the claim link", async () => {
    env();
    const host = new URL(base).host;
    replies.push(recoveryChallenge(host), {
      status: 200,
      body: { account: firstContact.account, payment: null },
    });
    const output = capture();
    const code = await runWallet(["recover"]);
    expect(code).toBe(0);
    expect(output()).not.toContain(AGENT_TOKEN);
    const claimUrl = firstContact.account.claim.url;
    expect(output().split(claimUrl)).toHaveLength(2);
    expect(output().replace(claimUrl, "")).not.toContain(CLAIM);
    expect(output()).toContain(address);
    expect(await getWalletToken(base, address)).toBe(AGENT_TOKEN);
    expect(await getWalletClaimCredential(base, address)).toBe(CLAIM);

    const proof = JSON.parse(
      Buffer.from(String(seen[1].headers["sign-in-with-x"]), "base64").toString("utf-8"),
    );
    expect(proof.type).toBe("eip191");
    expect(proof.chainId).toBe(SEPOLIA);
    expect(proof.address).toBe(address);
    expect(proof.nonce).toBe("abc123");
    const message = formatSiweMessage(proof, 84532);
    expect(message.split("\n")).toEqual([
      `${host} wants you to sign in with your Ethereum account:`,
      address,
      "",
      "Recover your Stashwise wallet account",
      "",
      `URI: http://${host}/api/v1/x402/account/recover`,
      "Version: 1",
      "Chain ID: 84532",
      "Nonce: abc123",
      "Issued At: 2026-11-09T00:00:00Z",
      "Expiration Time: 2026-11-09T00:10:00Z",
      "Resources:",
      `- http://${host}/api/v1/x402/account/recover`,
    ]);
    expect(await recoverMessageAddress({ message, signature: proof.signature })).toBe(address);
  });

  it("clears a stored claim credential once the wallet is claimed", async () => {
    env();
    replies.push(recoveryChallenge(new URL(base).host), saved(firstContact));
    capture();
    await runWallet(["recover"]);
    replies.push(recoveryChallenge(new URL(base).host), {
      status: 200,
      body: { account: { ...firstContact.account, claim: null }, payment: null },
    });
    await runWallet(["recover"]);
    expect(await getWalletClaimCredential(base, address)).toBeNull();
  });

  it("shows no claim link for a wallet that is already claimed", async () => {
    env();
    replies.push(recoveryChallenge(new URL(base).host), {
      status: 200,
      body: { account: { ...firstContact.account, claim: null }, payment: null },
    });
    const output = capture();
    expect(await runWallet(["recover"])).toBe(0);
    expect(output()).not.toContain("Claim link");
  });

  it("still shows the claim link when the keychain fails", async () => {
    env();
    const original = keychain.set.bind(keychain);
    keychain.set = () => {
      throw new Error("locked");
    };
    try {
      replies.push(recoveryChallenge(new URL(base).host), {
        status: 200,
        body: { account: firstContact.account, payment: null },
      });
      const output = capture();
      expect(await runWallet(["recover"])).toBe(1);
      expect(output().split(firstContact.account.claim.url)).toHaveLength(2);
      expect(output()).not.toContain(AGENT_TOKEN);
    } finally {
      keychain.set = original;
    }
  });

  it.each([
    ["domain", { domain: "evil.example" }],
    ["uri", { uri: "https://evil.example/recover" }],
  ])("signs nothing for a challenge with a foreign %s", async (_label, over) => {
    env();
    replies.push(recoveryChallenge(new URL(base).host, over));
    const output = capture();
    expect(await runWallet(["recover"])).toBe(1);
    expect(output()).toContain("different host");
    expect(seen).toHaveLength(1);
  });

  it("explains a wallet with no account", async () => {
    env();
    replies.push(recoveryChallenge(new URL(base).host), { status: 404, body: {} });
    const output = capture();
    expect(await runWallet(["recover"])).toBe(1);
    expect(output()).toContain("no Stashwise account yet");
  });

  it("needs a configured wallet", async () => {
    vi.stubEnv("STASHWISE_API_URL", base);
    vi.stubEnv("STASHWISE_WALLET_PRIVATE_KEY", "");
    capture();
    expect(await runWallet(["recover"])).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("doctor", () => {
  function run() {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    return runDoctor().then(() => out);
  }

  beforeEach(() => {
    vi.stubEnv("STASHWISE_API_URL", "");
    replies.push({ status: 200, body: {} });
  });

  it("reports presence and caps, never the key", async () => {
    vi.stubEnv("STASHWISE_API_URL", base);
    vi.stubEnv("STASHWISE_WALLET_PRIVATE_KEY", key);
    vi.stubEnv("STASHWISE_WALLET_MAX_PER_CALL_USD", "0.30");
    vi.stubEnv("STASHWISE_WALLET_MAX_PER_DAY_USD", "2");
    const out = await run();
    expect(out).toContain(`configured, address ${address}`);
    expect(out).toContain("$0.30 per call, $2.00 per day, $0.00 committed today");
    expect(out).not.toContain(key.slice(2));
  });

  it("says a wallet is optional when absent", async () => {
    vi.stubEnv("STASHWISE_API_URL", base);
    vi.stubEnv("STASHWISE_WALLET_PRIVATE_KEY", "");
    expect(await run()).toContain("not configured (optional)");
  });

  it("flags missing caps", async () => {
    vi.stubEnv("STASHWISE_API_URL", base);
    vi.stubEnv("STASHWISE_WALLET_PRIVATE_KEY", key);
    vi.stubEnv("STASHWISE_WALLET_MAX_PER_CALL_USD", "");
    const out = await run();
    expect(out).toContain("✗  Wallet caps");
    expect(out).not.toContain(key.slice(2));
  });
});
