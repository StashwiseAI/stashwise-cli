// Local record of what this machine's wallet has committed to spend today.
//
// The daily cap has to hold across every MCP server and CLI process on the
// machine, and has to hold before a signature exists, so each payment reserves
// its amount here first under a lock file. An unreadable ledger refuses the
// payment: resetting it would silently reset the cap.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

interface DayEntry {
  day: string;
  spent: string;
}

type LedgerFile = Record<string, DayEntry>;

export class SpendLedgerError extends Error {}

export interface Reservation {
  address: string;
  day: string;
  amount: bigint;
}

export type ReserveOutcome =
  | { ok: true; reservation: Reservation; spentAfter: bigint }
  | { ok: false; spent: bigint };

function ledgerDir(): string {
  return join(homedir(), ".stashwise");
}

function ledgerPath(): string {
  return join(ledgerDir(), "x402-spend.json");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

async function withLock<T>(work: () => Promise<T>): Promise<T> {
  await fs.mkdir(ledgerDir(), { recursive: true, mode: 0o700 });
  const lock = `${ledgerPath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await fs.open(lock, "wx", 0o600)).close();
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      const age = await fs
        .stat(lock)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await fs.unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new SpendLedgerError(
          "Could not lock the wallet spend ledger, so no payment was made. Try again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await work();
  } finally {
    await fs.unlink(lock).catch(() => undefined);
  }
}

async function readLedger(): Promise<LedgerFile> {
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath(), "utf-8");
  } catch (err) {
    if (isMissing(err)) return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as LedgerFile;
    for (const entry of Object.values(parsed)) {
      BigInt(entry.spent);
    }
    return parsed;
  } catch {
    throw new SpendLedgerError(
      `The wallet spend ledger at ${ledgerPath()} is unreadable, so no payment was made. Inspect it, then delete it to reset today's total.`,
    );
  }
}

async function writeLedger(ledger: LedgerFile): Promise<void> {
  const temp = `${ledgerPath()}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(ledger), { mode: 0o600 });
  await fs.rename(temp, ledgerPath());
}

function spentToday(ledger: LedgerFile, address: string, day: string): bigint {
  const entry = ledger[address];
  return entry && entry.day === day ? BigInt(entry.spent) : 0n;
}

/** Commit `amount` against today's cap, or report that it would not fit. */
export async function reserveSpend(
  address: string,
  amount: bigint,
  perDayCap: bigint,
): Promise<ReserveOutcome> {
  const key = address.toLowerCase();
  return withLock(async () => {
    const ledger = await readLedger();
    const day = today();
    const spent = spentToday(ledger, key, day);
    const spentAfter = spent + amount;
    if (spentAfter > perDayCap) {
      return { ok: false, spent };
    }
    ledger[key] = { day, spent: spentAfter.toString() };
    await writeLedger(ledger);
    return {
      ok: true,
      reservation: { address: key, day, amount },
      spentAfter,
    };
  });
}

/** Give a reservation back. Only for a payment proven not to have been charged. */
export async function releaseSpend(reservation: Reservation): Promise<void> {
  await withLock(async () => {
    const ledger = await readLedger();
    const entry = ledger[reservation.address];
    if (!entry || entry.day !== reservation.day) return;
    const left = BigInt(entry.spent) - reservation.amount;
    ledger[reservation.address] = {
      day: entry.day,
      spent: (left > 0n ? left : 0n).toString(),
    };
    await writeLedger(ledger);
  });
}

/** Today's committed total, for `doctor`. */
export async function spentTodayFor(address: string): Promise<bigint> {
  return spentToday(await readLedger(), address.toLowerCase(), today());
}
