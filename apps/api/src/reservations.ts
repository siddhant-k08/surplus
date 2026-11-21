import { randomUUID } from "node:crypto";
import type { Sql } from "./pg";

/**
 * Money committed to a generation that has not finished yet.
 *
 * The lifetime research budget is counted from the briefs that were stored, which is the durable
 * record. A generation in flight has committed real money and has stored nothing, so without this two
 * instances starting at the same moment each read the same total and each believe there is room.
 *
 * Shared, because that is the whole point: a reservation held in one process is invisible to the next
 * one the host starts.
 *
 * Stale reservations are ignored and swept. An instance killed mid-generation never releases its own,
 * and a budget permanently consumed by a crash would be a worse failure than the overspend this
 * prevents.
 */

export const STALE_AFTER_MS = 10 * 60_000;

export interface Reservations {
    /** Commits an amount and returns the handle that releases it. */
    open(amountUsdcMinor: bigint): Promise<string>;
    /** Releases one. Safe to call twice. */
    close(id: string): Promise<void>;
    /** Everything currently committed and not yet stale. */
    outstanding(): Promise<bigint>;
    /**
     * What was committed ahead of this one, not counting it.
     *
     * This is what makes a race have a winner. Two requests that reserve at the same moment both see a
     * total that includes the other, so both would stand down and neither would be served although
     * there was room for one. Ordering the queue means the first one through fits and the later one
     * backs off, which is both correct about the money and useful to somebody.
     */
    outstandingBefore(id: string): Promise<bigint>;
}

export class MemoryReservations implements Reservations {
    private readonly held = new Map<string, { amount: bigint; at: number; seq: number }>();
    private seq = 0;

    constructor(private readonly now: () => number = () => Date.now()) {}

    async open(amountUsdcMinor: bigint): Promise<string> {
        const id = randomUUID();
        this.seq += 1;
        this.held.set(id, { amount: amountUsdcMinor, at: this.now(), seq: this.seq });
        return id;
    }

    async outstandingBefore(id: string): Promise<bigint> {
        const mine = this.held.get(id);
        if (mine === undefined) return this.outstanding();
        const cutoff = this.now() - STALE_AFTER_MS;
        let total = 0n;
        for (const [key, held] of this.held) {
            if (key === id || held.at <= cutoff) continue;
            if (held.seq < mine.seq) total += held.amount;
        }
        return total;
    }

    async close(id: string): Promise<void> {
        this.held.delete(id);
    }

    async outstanding(): Promise<bigint> {
        const cutoff = this.now() - STALE_AFTER_MS;
        let total = 0n;
        for (const [id, held] of this.held) {
            if (held.at <= cutoff) {
                this.held.delete(id);
                continue;
            }
            total += held.amount;
        }
        return total;
    }
}

export class PgReservations implements Reservations {
    constructor(private readonly sql: Sql, private readonly now: () => number = () => Date.now()) {}

    async open(amountUsdcMinor: bigint): Promise<string> {
        const id = randomUUID();
        await this.sql`
            insert into research_reservations ${this.sql([{
                id,
                amount_usdc_minor: amountUsdcMinor.toString(),
                at: new Date(this.now()),
            }])}
        `;
        return id;
    }

    async close(id: string): Promise<void> {
        await this.sql`delete from research_reservations where id = ${id}`;
    }

    async outstanding(): Promise<bigint> {
        const cutoff = new Date(this.now() - STALE_AFTER_MS);
        await this.sql`delete from research_reservations where at <= ${cutoff}`;
        const [row] = await this.sql<{ total: string }[]>`
            select coalesce(sum(amount_usdc_minor::numeric), 0)::text as total from research_reservations
        `;
        return BigInt(row?.total ?? "0");
    }

    async outstandingBefore(id: string): Promise<bigint> {
        const cutoff = new Date(this.now() - STALE_AFTER_MS);
        // (at, id) orders the queue: the clock first, and the id only to break a tie inside one
        // millisecond, so two instances always agree on who was ahead
        const [row] = await this.sql<{ total: string }[]>`
            select coalesce(sum(amount_usdc_minor::numeric), 0)::text as total
            from research_reservations
            where at > ${cutoff}
              and (at, id) < (select at, id from research_reservations where id = ${id})
        `;
        return BigInt(row?.total ?? "0");
    }
}
