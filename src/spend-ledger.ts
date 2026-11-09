// Local record of what this machine's wallet has committed to spend today.
//
// The daily cap has to hold across every MCP server and CLI process on the
// machine, and has to hold before a signature exists, so each payment reserves
// its amount here first under a lock file. An unreadable ledger refuses the
// payment: resetting it would silently reset the cap.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const ATOMIC_AMOUNT = /^\d+$/;

interface DayEntry {
  day: string;
  spent: string;
}

type LedgerFile = Record<string, DayEntry>;

interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

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

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

function lockPath(): string {
  return `${ledgerPath()}.lock`;
}

function reapGuardPath(): string {
  return `${lockPath()}.reap`;
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const owner = JSON.parse(raw) as Partial<LockOwner> | null;
    return owner &&
      Number.isSafeInteger(owner.pid) &&
      (owner.pid as number) > 0 &&
      typeof owner.host === "string" &&
      typeof owner.token === "string"
      ? (owner as LockOwner)
      : null;
  } catch {
    return null;
  }
}

/** Who holds the lock: an owner, nobody ("free"), or something unreadable. */
async function readHolder(): Promise<LockOwner | "free" | "unreadable"> {
  try {
    return parseOwner(await fs.readFile(lockPath(), "utf-8")) ?? "unreadable";
  } catch (err) {
    if (isMissing(err)) return "free";
    throw err;
  }
}

/**
 * True only when the owner certainly no longer exists. Age proves nothing: a
 * suspended process still holds its snapshot of the ledger and will write it.
 */
function ownerIsGone(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return errorCode(err) === "ESRCH";
  }
}

/**
 * Remove a dead owner's lock. The guard makes the check and the unlink one step:
 * without it, a second reaper acting on the same dead owner would unlink the
 * lock a live process had just taken.
 */
async function reapDeadOwner(token: string, claim: string): Promise<void> {
  try {
    await fs.link(claim, reapGuardPath());
  } catch (err) {
    if (errorCode(err) === "EEXIST") return;
    throw err;
  }
  try {
    const holder = await readHolder();
    if (typeof holder === "object" && holder.token === token && ownerIsGone(holder)) {
      await fs.unlink(lockPath()).catch(() => undefined);
    }
  } finally {
    await fs.unlink(reapGuardPath()).catch(() => undefined);
  }
}

async function acquire(claim: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // A hard link appears complete, so a lock is never seen without its owner.
      await fs.link(claim, lockPath());
      return;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
    const holder = await readHolder();
    if (holder === "unreadable") {
      throw new SpendLedgerError(
        `The wallet spend lock at ${lockPath()} has no readable owner, so no payment was made. If no Stashwise process is running, delete that file.`,
      );
    }
    if (holder === "free") continue;
    if (ownerIsGone(holder)) {
      await reapDeadOwner(holder.token, claim);
    }
    if (Date.now() > deadline) {
      throw new SpendLedgerError(
        `Could not lock the wallet spend ledger, so no payment was made. Try again. If this keeps happening and no Stashwise process is running, delete ${lockPath()} and ${reapGuardPath()}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/** Throws unless this holder still owns the lock. Called before every commit. */
type Fence = () => Promise<void>;

async function withLock<T>(work: (fence: Fence) => Promise<T>): Promise<T> {
  await fs.mkdir(ledgerDir(), { recursive: true, mode: 0o700 });
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token: randomUUID(),
  };
  const claim = `${lockPath()}.${owner.token}`;
  await fs.writeFile(claim, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  try {
    await acquire(claim);
  } finally {
    await fs.unlink(claim).catch(() => undefined);
  }
  const owned = async () => {
    const holder = await readHolder();
    return typeof holder === "object" && holder.token === owner.token;
  };
  try {
    return await work(async () => {
      if (!(await owned())) {
        throw new SpendLedgerError(
          "The wallet spend lock was lost before this change was saved, so no payment was made. Try again.",
        );
      }
    });
  } finally {
    if (await owned().catch(() => false)) {
      await fs.unlink(lockPath()).catch(() => undefined);
    }
  }
}

/** A day that cannot exist would never equal today, silently resetting the total. */
function isCalendarDay(day: string): boolean {
  if (!DAY_FORMAT.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function isDayEntry(value: unknown): value is DayEntry {
  if (typeof value !== "object" || value === null) return false;
  const { day, spent } = value as Partial<DayEntry>;
  return (
    typeof day === "string" &&
    isCalendarDay(day) &&
    typeof spent === "string" &&
    ATOMIC_AMOUNT.test(spent)
  );
}

function parseLedger(raw: string): LedgerFile | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return Object.values(parsed).every(isDayEntry) ? (parsed as LedgerFile) : null;
  } catch {
    return null;
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
  const ledger = parseLedger(raw);
  if (ledger === null) {
    throw new SpendLedgerError(
      `The wallet spend ledger at ${ledgerPath()} is unreadable, so no payment was made. Inspect it, then delete it to reset today's total.`,
    );
  }
  return ledger;
}

async function writeLedger(ledger: LedgerFile, fence: Fence): Promise<void> {
  const temp = `${ledgerPath()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(ledger), { mode: 0o600 });
    await fence();
    await fs.rename(temp, ledgerPath());
  } catch (err) {
    await fs.unlink(temp).catch(() => undefined);
    throw err;
  }
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
  return withLock(async (fence) => {
    const ledger = await readLedger();
    const day = today();
    const spent = spentToday(ledger, key, day);
    const spentAfter = spent + amount;
    if (spentAfter > perDayCap) {
      return { ok: false, spent };
    }
    ledger[key] = { day, spent: spentAfter.toString() };
    await writeLedger(ledger, fence);
    return {
      ok: true,
      reservation: { address: key, day, amount },
      spentAfter,
    };
  });
}

/** Give a reservation back. Only for a payment proven not to have been charged. */
export async function releaseSpend(reservation: Reservation): Promise<void> {
  await withLock(async (fence) => {
    const ledger = await readLedger();
    const entry = ledger[reservation.address];
    if (!entry || entry.day !== reservation.day) return;
    const left = BigInt(entry.spent) - reservation.amount;
    ledger[reservation.address] = {
      day: entry.day,
      spent: (left > 0n ? left : 0n).toString(),
    };
    await writeLedger(ledger, fence);
  });
}

/** Today's committed total, for `doctor`. */
export async function spentTodayFor(address: string): Promise<bigint> {
  return spentToday(await readLedger(), address.toLowerCase(), today());
}
