// Opt in wallet: an agent's own key pays per save over x402.
//
// Everything is driven by STASHWISE_WALLET_PRIVATE_KEY. The key is read once
// into a viem account and never stored on any object here, and no message in
// this file includes it. viem is imported on demand because the prompt hook
// shares this binary and runs on every prompt.

import { randomBytes } from "node:crypto";
import { redactServerText } from "./redact.js";
import {
  releaseSpend,
  reserveSpend,
  type Reservation,
} from "./spend-ledger.js";

const PAYMENT_IDENTIFIER = "payment-identifier";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ATOMIC_RE = /^[1-9][0-9]*$/;
const USD_RE = /^[0-9]+(\.[0-9]{1,6})?$/;
const USDC_DECIMALS = 6;
// An authorization is a signed cheque, so it should not outlive the call by
// much even if a server advertises a long window.
const MAX_VALIDITY_SECONDS = 600;

export const WALLET_KEY_ENV = "STASHWISE_WALLET_PRIVATE_KEY";
export const WALLET_PER_CALL_ENV = "STASHWISE_WALLET_MAX_PER_CALL_USD";
export const WALLET_PER_DAY_ENV = "STASHWISE_WALLET_MAX_PER_DAY_USD";

/** The only assets this client will ever sign for. Terms come from here, not the server. */
const KNOWN_USDC: Record<
  string,
  { chainId: number; asset: string; name: string; version: string }
> = {
  "eip155:8453": {
    chainId: 8453,
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532": {
    chainId: 84532,
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    name: "USDC",
    version: "2",
  },
};

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export class WalletConfigError extends Error {}

export class WalletCapError extends Error {}

export class PaymentRefusedError extends Error {
  constructor(message: string) {
    super(redactServerText(message));
  }
}

/** The payment may have been charged and this client cannot tell. */
export class PaymentOutcomeUnknownError extends Error {
  constructor(readonly paymentIdentifier: string) {
    super(
      `The payment outcome is unknown (identifier ${paymentIdentifier}). It may have been charged, so do not retry this save. It stays counted against today's cap.`,
    );
  }
}

interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
}

interface PaymentRequired {
  x402Version: number;
  resource?: unknown;
  accepts?: PaymentRequirements[];
  extensions?: Record<string, { info?: Record<string, unknown> } | undefined>;
}

export interface PreparedPayment {
  /** Value for the PAYMENT-SIGNATURE header. */
  header: string;
  identifier: string;
  /** Give the amount back to today's cap. Only when proven not charged. */
  release(): Promise<void>;
}

export interface WalletCaps {
  perCall: bigint;
  perDay: bigint;
}

interface WalletAccount {
  address: string;
  signTypedData(args: unknown): Promise<string>;
  signMessage(args: { message: string }): Promise<string>;
}

export interface SiwxChallenge {
  info: Record<string, unknown>;
  supportedChains?: { chainId: string; type: string }[];
}

/** Dollars as USDC atomic units. Exact, and refuses anything that is not a plain decimal. */
export function usdToAtomic(value: string): bigint {
  if (!USD_RE.test(value)) {
    throw new WalletConfigError(`Not a dollar amount: ${value}`);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(USDC_DECIMALS, "0"));
}

export function atomicToUsd(atomic: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (atomic % scale).toString().padStart(USDC_DECIMALS, "0");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${atomic / scale}.${trimmed}`;
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

function decodeChallenge(header: string): PaymentRequired {
  try {
    return JSON.parse(
      Buffer.from(header, "base64").toString("utf-8"),
    ) as PaymentRequired;
  } catch {
    throw new PaymentRefusedError(
      "The server's payment terms could not be read, so nothing was signed.",
    );
  }
}

function usableTerms(required: PaymentRequirements): boolean {
  const known = KNOWN_USDC[required.network];
  return (
    required.scheme === "exact" &&
    known !== undefined &&
    required.asset?.toLowerCase() === known.asset &&
    required.extra?.name === known.name &&
    required.extra?.version === known.version &&
    ATOMIC_RE.test(required.amount ?? "") &&
    ADDRESS_RE.test(required.payTo ?? "") &&
    Number.isInteger(required.maxTimeoutSeconds) &&
    required.maxTimeoutSeconds > 0
  );
}

function generatePaymentIdentifier(): string {
  return `pay_${randomBytes(16).toString("hex")}`;
}

export class Wallet {
  constructor(
    private readonly account: WalletAccount,
    readonly caps: WalletCaps | null,
    readonly capsProblem: string | null,
  ) {}

  get address(): string {
    return this.account.address;
  }

  /**
   * Turn a PAYMENT-REQUIRED header into a signed payment, after checking the
   * terms and committing the amount against both caps. Throws, having signed
   * nothing, when any check fails.
   */
  async prepare(challengeHeader: string): Promise<PreparedPayment> {
    if (!this.caps) {
      throw new WalletConfigError(this.capsProblem ?? "Wallet caps are not set.");
    }
    const challenge = decodeChallenge(challengeHeader);
    if (challenge.x402Version !== 2) {
      throw new PaymentRefusedError(
        "The server asked for an x402 version this client does not support, so nothing was signed.",
      );
    }
    const terms = challenge.accepts?.find(usableTerms);
    if (!terms) {
      throw new PaymentRefusedError(
        "The server offered no USDC terms this client accepts, so nothing was signed.",
      );
    }
    const declared = challenge.extensions?.[PAYMENT_IDENTIFIER];
    if (!declared) {
      throw new PaymentRefusedError(
        "The server does not support payment identifiers, so a lost response could charge twice. Nothing was signed.",
      );
    }

    const amount = BigInt(terms.amount);
    if (amount > this.caps.perCall) {
      throw new WalletCapError(
        `This save costs $${atomicToUsd(amount)}, above the per call cap of $${atomicToUsd(this.caps.perCall)} (${WALLET_PER_CALL_ENV}). Nothing was signed.`,
      );
    }
    const reserved = await reserveSpend(this.address, amount, this.caps.perDay);
    if (!reserved.ok) {
      throw new WalletCapError(
        `This save costs $${atomicToUsd(amount)}, and $${atomicToUsd(reserved.spent)} is already committed today against the daily cap of $${atomicToUsd(this.caps.perDay)} (${WALLET_PER_DAY_ENV}). Nothing was signed.`,
      );
    }

    try {
      return await this.sign(challenge, terms, declared, reserved.reservation);
    } catch (err) {
      await releaseSpend(reserved.reservation).catch(() => undefined);
      if (err instanceof PaymentRefusedError) throw err;
      throw new PaymentRefusedError(
        "This payment could not be signed, so nothing was sent.",
      );
    }
  }

  private async sign(
    challenge: PaymentRequired,
    terms: PaymentRequirements,
    declared: { info?: Record<string, unknown> },
    reservation: Reservation,
  ): Promise<PreparedPayment> {
    const known = KNOWN_USDC[terms.network];
    const from = this.address.toLowerCase();
    const to = terms.payTo.toLowerCase();
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const validBefore =
      Math.floor(Date.now() / 1000) +
      Math.min(terms.maxTimeoutSeconds, MAX_VALIDITY_SECONDS);
    const signature = await this.account.signTypedData({
      domain: {
        name: known.name,
        version: known.version,
        chainId: known.chainId,
        verifyingContract: known.asset,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from,
        to,
        value: BigInt(terms.amount),
        validAfter: 0n,
        validBefore: BigInt(validBefore),
        nonce,
      },
    });
    const identifier = generatePaymentIdentifier();
    const header = encodeBase64Json({
      x402Version: 2,
      resource: challenge.resource,
      accepted: terms,
      payload: {
        signature,
        authorization: {
          from,
          to,
          value: terms.amount,
          validAfter: "0",
          validBefore: String(validBefore),
          nonce,
        },
      },
      extensions: {
        [PAYMENT_IDENTIFIER]: {
          ...declared,
          info: { ...declared.info, id: identifier },
        },
      },
    });
    return { header, identifier, release: () => releaseSpend(reservation) };
  }

  /**
   * Answer a recovery challenge with a SIGN-IN-WITH-X header. Refuses a
   * challenge for any host but `expectedHost`: a signature over another
   * site's challenge would hand that site this wallet's account.
   */
  async proveControl(
    challenge: SiwxChallenge,
    expectedHost: string,
  ): Promise<string> {
    const { info } = challenge;
    const chain = challenge.supportedChains?.find(
      (c) => c.type === "eip191" && KNOWN_USDC[c.chainId] !== undefined,
    );
    if (!chain) {
      throw new PaymentRefusedError(
        "The server's recovery challenge names no supported chain, so nothing was signed.",
      );
    }
    let uriHost: string;
    try {
      uriHost = new URL(String(info.uri)).host;
    } catch {
      uriHost = "";
    }
    if (info.domain !== expectedHost || uriHost !== expectedHost) {
      throw new PaymentRefusedError(
        `The recovery challenge is for a different host than ${expectedHost}, so nothing was signed.`,
      );
    }
    const fields = {
      domain: info.domain,
      address: this.address,
      uri: info.uri,
      version: info.version,
      chainId: chain.chainId,
      type: "eip191",
      nonce: info.nonce,
      issuedAt: info.issuedAt,
      statement: info.statement,
      expirationTime: info.expirationTime,
      notBefore: info.notBefore,
      requestId: info.requestId,
      resources: info.resources,
    };
    const signature = await this.account.signMessage({
      message: formatSiweMessage(fields, KNOWN_USDC[chain.chainId].chainId),
    });
    return encodeBase64Json({ ...fields, signature });
  }
}

/** EIP-4361 text, line for line what the server rebuilds and verifies. */
export function formatSiweMessage(
  fields: {
    domain: unknown;
    address: string;
    statement?: unknown;
    uri: unknown;
    version: unknown;
    nonce: unknown;
    issuedAt: unknown;
    expirationTime?: unknown;
    notBefore?: unknown;
    requestId?: unknown;
    resources?: unknown;
  },
  chainId: number,
): string {
  const lines = [
    `${String(fields.domain)} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
  ];
  if (fields.statement) {
    lines.push(String(fields.statement), "");
  } else {
    lines.push("");
  }
  lines.push(
    `URI: ${String(fields.uri)}`,
    `Version: ${String(fields.version)}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${String(fields.nonce)}`,
    `Issued At: ${String(fields.issuedAt)}`,
  );
  const optional: [string, unknown][] = [
    ["Expiration Time", fields.expirationTime],
    ["Not Before", fields.notBefore],
    ["Request ID", fields.requestId],
  ];
  for (const [label, value] of optional) {
    if (value !== undefined && value !== null) {
      lines.push(`${label}: ${String(value)}`);
    }
  }
  if (Array.isArray(fields.resources) && fields.resources.length > 0) {
    lines.push("Resources:", ...fields.resources.map((r) => `- ${String(r)}`));
  }
  return lines.join("\n");
}

export type WalletState =
  | { status: "absent" }
  | { status: "invalid"; problem: string }
  | { status: "ready"; wallet: Wallet };

function readCaps(env: NodeJS.ProcessEnv): {
  caps: WalletCaps | null;
  problem: string | null;
} {
  const perCallRaw = env[WALLET_PER_CALL_ENV]?.trim();
  const perDayRaw = env[WALLET_PER_DAY_ENV]?.trim();
  if (!perCallRaw || !perDayRaw) {
    return {
      caps: null,
      problem: `Set both ${WALLET_PER_CALL_ENV} and ${WALLET_PER_DAY_ENV}. The wallet will not spend without them.`,
    };
  }
  try {
    const perCall = usdToAtomic(perCallRaw);
    const perDay = usdToAtomic(perDayRaw);
    if (perCall <= 0n || perDay <= 0n) {
      throw new WalletConfigError("zero");
    }
    return { caps: { perCall, perDay }, problem: null };
  } catch {
    return {
      caps: null,
      problem: `${WALLET_PER_CALL_ENV} and ${WALLET_PER_DAY_ENV} must be dollar amounts above zero, for example 0.30. The wallet will not spend without them.`,
    };
  }
}

/** Read the wallet from the environment. Absent means the feature is off. */
export async function loadWallet(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WalletState> {
  const key = env[WALLET_KEY_ENV]?.trim();
  if (!key) {
    return { status: "absent" };
  }
  if (!PRIVATE_KEY_RE.test(key)) {
    return {
      status: "invalid",
      problem: `${WALLET_KEY_ENV} must be 0x followed by 64 hex characters.`,
    };
  }
  let account: WalletAccount;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    account = privateKeyToAccount(key as `0x${string}`) as unknown as WalletAccount;
  } catch {
    // Never forward the library's message: it may describe the input.
    return {
      status: "invalid",
      problem: `${WALLET_KEY_ENV} is not a usable private key.`,
    };
  }
  const { caps, problem } = readCaps(env);
  return { status: "ready", wallet: new Wallet(account, caps, problem) };
}


