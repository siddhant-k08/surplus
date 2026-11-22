import type { Sql } from "./pg";

/**
 * What the agent has tried to do onchain, written down before it tries.
 *
 * A swap is the only thing here that cannot be undone, and the dangerous moment is not the swap: it is
 * the gap between broadcasting one and recording it. A process that dies in that gap leaves money moved
 * and books that do not know, and no amount of care inside a single function closes it, because the
 * crash can land between any two statements.
 *
 * So the order is inverted. The transaction is signed first, which fixes its hash without putting it on
 * the chain; the hash is written here; only then is it broadcast. A restart can therefore always ask the
 * chain what happened to a transaction it had decided to send, and the raw signed bytes are kept so the
 * same transaction can be rebroadcast rather than a second one built.
 *
 * It is also where the spend cap is counted, for the same reason the research budget moved: a cap held
 * in a process is a cap per process, and a host that runs several has no cap at all.
 */

export type ExecutionStatus = "pending" | "sent" | "filled" | "failed";

export interface ExecutionRecord {
    /** Identifies the intended swap: one per proposal and order, so a retry cannot send twice. */
    key: string;
    status: ExecutionStatus;
    symbol: string;
    asset: string;
    usdcInMinor: bigint;
    /** Known as soon as the transaction is signed, before it is broadcast. */
    txHash?: string | undefined;
    /** The signed transaction, so recovery can rebroadcast rather than rebuild. */
    rawTx?: string | undefined;
    amountOutMinor?: bigint | undefined;
    gasUsed?: bigint | undefined;
    /** Why it failed, when it did. */
    detail?: string | undefined;
    at: string;
}

export interface ExecutionJournal {
    find(key: string): Promise<ExecutionRecord | null>;
    /** Claims the key. Returns what is already stored when it was claimed before, and writes nothing. */
    reserve(r: { key: string; symbol: string; asset: string; usdcInMinor: bigint }): Promise<ExecutionRecord>;
    /** Records the signed transaction before it is broadcast. */
    recordSigned(key: string, txHash: string, rawTx: string): Promise<void>;
    settle(key: string, outcome: {
        status: "filled" | "failed";
        amountOutMinor?: bigint;
        gasUsed?: bigint;
        detail?: string;
    }): Promise<void>;
    /** Releases a claim that never reached a signature, so a refusal does not eat the cap. */
    release(key: string): Promise<void>;
    /** Everything committed and not known to have failed. This is what the spend cap is measured against. */
    committedUsdcMinor(): Promise<bigint>;
    /** Transactions that were signed and whose outcome is unknown. Resolved against the chain on start. */
    unresolved(): Promise<ExecutionRecord[]>;
    /** Everything that filled. The agent's own record of what the chain gave it. */
    filled(): Promise<ExecutionRecord[]>;
}

const clone = (r: ExecutionRecord): ExecutionRecord => ({ ...r });

export class MemoryJournal implements ExecutionJournal {
    private readonly rows = new Map<string, ExecutionRecord>();

    constructor(private readonly now: () => Date = () => new Date()) {}

    async find(key: string): Promise<ExecutionRecord | null> {
        const found = this.rows.get(key);
        return found === undefined ? null : clone(found);
    }

    async reserve(r: { key: string; symbol: string; asset: string; usdcInMinor: bigint }): Promise<ExecutionRecord> {
        const existing = this.rows.get(r.key);
        if (existing !== undefined) return clone(existing);
        const row: ExecutionRecord = { ...r, status: "pending", at: this.now().toISOString() };
        this.rows.set(r.key, row);
        return clone(row);
    }

    async recordSigned(key: string, txHash: string, rawTx: string): Promise<void> {
        const row = this.rows.get(key);
        if (row === undefined) throw new Error(`no execution reserved for ${key}`);
        row.txHash = txHash;
        row.rawTx = rawTx;
        row.status = "sent";
    }

    async settle(key: string, outcome: {
        status: "filled" | "failed";
        amountOutMinor?: bigint;
        gasUsed?: bigint;
        detail?: string;
    }): Promise<void> {
        const row = this.rows.get(key);
        if (row === undefined) throw new Error(`no execution reserved for ${key}`);
        row.status = outcome.status;
        row.amountOutMinor = outcome.amountOutMinor;
        row.gasUsed = outcome.gasUsed;
        row.detail = outcome.detail;
    }

    async release(key: string): Promise<void> {
        const row = this.rows.get(key);
        if (row?.status === "pending") this.rows.delete(key);
    }

    async committedUsdcMinor(): Promise<bigint> {
        let total = 0n;
        for (const row of this.rows.values()) if (row.status !== "failed") total += row.usdcInMinor;
        return total;
    }

    async unresolved(): Promise<ExecutionRecord[]> {
        return [...this.rows.values()].filter((r) => r.status === "sent").map(clone);
    }

    async filled(): Promise<ExecutionRecord[]> {
        return [...this.rows.values()].filter((r) => r.status === "filled").map(clone);
    }
}

interface Row {
    key: string;
    status: string;
    symbol: string;
    asset: string;
    usdc_in_minor: string;
    tx_hash: string | null;
    raw_tx: string | null;
    amount_out_minor: string | null;
    gas_used: string | null;
    detail: string | null;
    at: Date;
}

const fromRow = (r: Row): ExecutionRecord => ({
    key: r.key,
    status: r.status as ExecutionStatus,
    symbol: r.symbol,
    asset: r.asset,
    usdcInMinor: BigInt(r.usdc_in_minor),
    ...(r.tx_hash !== null && { txHash: r.tx_hash }),
    ...(r.raw_tx !== null && { rawTx: r.raw_tx }),
    ...(r.amount_out_minor !== null && { amountOutMinor: BigInt(r.amount_out_minor) }),
    ...(r.gas_used !== null && { gasUsed: BigInt(r.gas_used) }),
    ...(r.detail !== null && { detail: r.detail }),
    at: r.at.toISOString(),
});

export class PgJournal implements ExecutionJournal {
    constructor(private readonly sql: Sql, private readonly now: () => Date = () => new Date()) {}

    async find(key: string): Promise<ExecutionRecord | null> {
        const rows = await this.sql<Row[]>`select * from executions where key = ${key}`;
        return rows[0] === undefined ? null : fromRow(rows[0]);
    }

    async reserve(r: { key: string; symbol: string; asset: string; usdcInMinor: bigint }): Promise<ExecutionRecord> {
        // `do nothing` then read back: whoever claimed the key first owns it, and a second caller is
        // handed what is already there rather than a second swap
        await this.sql`
            insert into executions ${this.sql([{
                key: r.key,
                status: "pending",
                symbol: r.symbol,
                asset: r.asset,
                usdc_in_minor: r.usdcInMinor.toString(),
                at: this.now(),
            }])}
            on conflict (key) do nothing
        `;
        const found = await this.find(r.key);
        if (found === null) throw new Error(`execution ${r.key} vanished immediately after being reserved`);
        return found;
    }

    async recordSigned(key: string, txHash: string, rawTx: string): Promise<void> {
        const rows = await this.sql`
            update executions set status = 'sent', tx_hash = ${txHash}, raw_tx = ${rawTx}
            where key = ${key} returning key
        `;
        if (rows.length === 0) throw new Error(`no execution reserved for ${key}`);
    }

    async settle(key: string, outcome: {
        status: "filled" | "failed";
        amountOutMinor?: bigint;
        gasUsed?: bigint;
        detail?: string;
    }): Promise<void> {
        const rows = await this.sql`
            update executions set
                status = ${outcome.status},
                amount_out_minor = ${outcome.amountOutMinor?.toString() ?? null},
                gas_used = ${outcome.gasUsed?.toString() ?? null},
                detail = ${outcome.detail ?? null}
            where key = ${key} returning key
        `;
        if (rows.length === 0) throw new Error(`no execution reserved for ${key}`);
    }

    async release(key: string): Promise<void> {
        await this.sql`delete from executions where key = ${key} and status = 'pending'`;
    }

    async committedUsdcMinor(): Promise<bigint> {
        const [row] = await this.sql<{ total: string }[]>`
            select coalesce(sum(usdc_in_minor::numeric), 0)::text as total
            from executions where status <> 'failed'
        `;
        return BigInt(row?.total ?? "0");
    }

    async unresolved(): Promise<ExecutionRecord[]> {
        const rows = await this.sql<Row[]>`select * from executions where status = 'sent' order by at asc`;
        return rows.map(fromRow);
    }

    async filled(): Promise<ExecutionRecord[]> {
        const rows = await this.sql<Row[]>`select * from executions where status = 'filled' order by at asc`;
        return rows.map(fromRow);
    }
}
