import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Ledger, type AccountId, type EntryType, type Line, type LedgerTx, type Mode } from "./ledger";
import type { LedgerStore } from "./storage";

/**
 * Append-only JSONL persistence for the ledger, one entry per line in the order it was posted.
 *
 * JSONL suits an append-only ledger: writing a new entry never rewrites earlier ones, the file is its own
 * audit trail, and a reader can replay it in order. Amounts are stored as decimal strings of USDC minor
 * units, never JSON numbers, because a float would silently round money.
 */

const MODES: readonly Mode[] = ["sim", "testnet", "mainnet"];
const TYPES: readonly EntryType[] = [
    "OPENING_BALANCE", "PAYMENT_RECEIVED", "PAYMENT_FAILED", "COST_ACCRUED", "RESERVE_TOPUP",
    "SURPLUS_ALLOCATED", "PROPOSAL_CREATED", "REFUSAL", "APPROVAL_RECORDED", "PURCHASE_SETTLED",
    "RECONCILIATION",
];

/** One ledger entry as it appears on disk. */
export function serializeTx(tx: LedgerTx): string {
    return JSON.stringify({
        id: tx.id,
        at: tx.at,
        type: tx.type,
        mode: tx.mode,
        lines: tx.lines.map((l) => ({ account: l.account, amount: l.amount.toString() })),
        ...(tx.memo !== undefined && { memo: tx.memo }),
        ...(tx.txHash !== undefined && { txHash: tx.txHash }),
        ...(tx.idempotencyKey !== undefined && { idempotencyKey: tx.idempotencyKey }),
        ...(tx.briefId !== undefined && { briefId: tx.briefId }),
        ...(tx.theme !== undefined && { theme: tx.theme }),
    });
}

/**
 * Parses one stored entry, rejecting anything malformed rather than repairing it. Reading money back from
 * disk is the dangerous direction: a line that cannot be trusted must stop the process, not be guessed at.
 */
export function parseTxLine(line: string, where: string): LedgerTx {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        throw new Error(`${where}: not valid JSON. The ledger file may be truncated by an interrupted write.`);
    }
    if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not an object`);
    const r = raw as Record<string, unknown>;

    if (typeof r.id !== "number" || !Number.isInteger(r.id) || r.id < 1) throw new Error(`${where}: bad id`);
    if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) throw new Error(`${where}: bad timestamp`);
    if (typeof r.type !== "string" || !TYPES.includes(r.type as EntryType)) throw new Error(`${where}: unknown type ${String(r.type)}`);
    if (typeof r.mode !== "string" || !MODES.includes(r.mode as Mode)) throw new Error(`${where}: unknown mode ${String(r.mode)}`);
    // An empty `lines` array is legal: Treasury records events (REFUSAL, PROPOSAL_CREATED,
    // APPROVAL_RECORDED) as entries that move no money.
    if (!Array.isArray(r.lines)) throw new Error(`${where}: lines must be an array`);

    const lines: Line[] = r.lines.map((l: unknown, i: number) => {
        if (typeof l !== "object" || l === null) throw new Error(`${where}: line ${i} is not an object`);
        const o = l as Record<string, unknown>;
        if (typeof o.account !== "string" || o.account === "") throw new Error(`${where}: line ${i} has no account`);
        if (typeof o.amount !== "string" || !/^-?\d+$/.test(o.amount)) {
            throw new Error(`${where}: line ${i} amount must be a decimal string of minor units, got ${JSON.stringify(o.amount)}`);
        }
        return { account: o.account as AccountId, amount: BigInt(o.amount) };
    });

    return {
        id: r.id,
        at: r.at,
        type: r.type as EntryType,
        mode: r.mode as Mode,
        lines,
        ...(typeof r.memo === "string" && { memo: r.memo }),
        ...(typeof r.txHash === "string" && { txHash: r.txHash }),
        ...(typeof r.idempotencyKey === "string" && { idempotencyKey: r.idempotencyKey }),
        ...(typeof r.briefId === "string" && { briefId: r.briefId }),
        ...(typeof r.theme === "string" && { theme: r.theme }),
    };
}

/** Parses a whole file's worth of lines. Blank lines are skipped; a bad line throws. */
export function parseLedgerFile(text: string, where = "ledger"): LedgerTx[] {
    const out: LedgerTx[] = [];
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
        if (line.trim() === "") continue;
        const tx = parseTxLine(line, `${where} line ${i + 1}`);
        const prev = out[out.length - 1];
        // Ids are assigned from 1 in order and never reused, so the first entry must be 1 and each one
        // must follow the last. A missing first entry is as much a hole in the books as a missing middle
        // one, and replay would quietly carry on from whatever id it did find.
        if (prev === undefined && tx.id !== 1) {
            throw new Error(`${where} line ${i + 1}: the first entry has id ${tx.id}, not 1; the file is missing its beginning`);
        }
        if (prev && tx.id !== prev.id + 1) {
            throw new Error(`${where} line ${i + 1}: entry ids jump from ${prev.id} to ${tx.id}; the file is not intact`);
        }
        out.push(tx);
    }
    return out;
}

/** The books as append-only JSONL on a disk. One implementation of `LedgerStore`. */
export class JsonlLedgerStore implements LedgerStore {
    constructor(readonly path: string) {}

    /** Entries on disk, oldest first. An absent file is an empty ledger, not an error. */
    readSync(): LedgerTx[] {
        if (!existsSync(this.path)) return [];
        return parseLedgerFile(readFileSync(this.path, "utf8"), this.path);
    }

    async load(): Promise<LedgerTx[]> {
        return this.readSync();
    }

    /** A ledger rebuilt from disk, with its dedup index and balances restored. */
    loadLedger(): Ledger {
        return Ledger.replay(this.readSync());
    }

    /**
     * Appends entries in order, skipping any the file already holds.
     *
     * The skip makes a retry after a partial write safe: entry ids are assigned in order from 1, so
     * anything at or below the last stored id is already there.
     */
    async append(txs: readonly LedgerTx[]): Promise<void> {
        if (txs.length === 0) return;
        const lastStored = this.readSync().at(-1)?.id ?? 0;
        const fresh = txs.filter((t) => t.id > lastStored);
        if (fresh.length === 0) return;
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, fresh.map((t) => serializeTx(t) + "\n").join(""));
    }
}

/** A sale the ledger actually records: a payment entry carrying its settlement transaction. */
export interface RealizedSale {
    transaction: string;
    amountUsdcMinor: bigint;
    briefId: string | undefined;
    at: string;
    mode: Mode;
}

/**
 * The sales a ledger proves, read back from its entries.
 *
 * This is the single answer to "what did the agent actually earn", so the paid endpoint and the investing
 * loop cannot disagree about it. Only `PAYMENT_RECEIVED` entries that carry a settlement transaction count:
 * a payment with no transaction did not arrive onchain.
 */
export function realizedSales(entries: readonly LedgerTx[]): RealizedSale[] {
    const out: RealizedSale[] = [];
    for (const e of entries) {
        if (e.type !== "PAYMENT_RECEIVED" || e.txHash === undefined) continue;
        const cash = e.lines.find((l) => l.account === "cash.operating");
        if (cash === undefined || cash.amount <= 0n) continue;
        out.push({
            transaction: e.txHash,
            amountUsdcMinor: cash.amount,
            briefId: e.briefId,
            at: e.at,
            mode: e.mode,
        });
    }
    return out;
}

/** Total USDC minor units the ledger proves were received. */
export const realizedRevenue = (entries: readonly LedgerTx[]): bigint =>
    realizedSales(entries).reduce((a, s) => a + s.amountUsdcMinor, 0n);
