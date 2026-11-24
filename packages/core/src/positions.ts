import type { LedgerTx } from "./ledger";

/**
 * What the agent holds, rebuilt from the books.
 *
 * `positions.<asset>` says what was paid; the entry's `units` field says what was bought. Both are
 * needed and neither is enough alone: money without units cannot be valued, and units without money
 * have no cost to compare a price against.
 *
 * Cost basis is average cost, not FIFO. Two buys of the same token at different prices become one
 * position at the blended price, and a partial sale takes its cost out in proportion. Average cost is
 * the right choice here because the agent accumulates one position per token over many small buys and
 * has no lot identity to preserve: FIFO would need a lot ledger and would answer a question nobody is
 * asking. It is stated rather than assumed because the realized gain on a partial sale depends on it.
 */

export interface Position {
    /** Lowercase token address. */
    asset: string;
    /** Token minor units currently held. */
    units: bigint;
    /** USDC minor units paid for the units still held. Falls as units are sold. */
    costUsdcIn: bigint;
    /** USDC minor units of gain (positive) or loss (negative) actually taken by selling. */
    realizedUsdc: bigint;
    buys: number;
    sells: number;
    /**
     * Buys that recorded no units, whose money is in `costUsdcIn` and whose tokens are not in `units`.
     *
     * A position with any of these has a cost basis covering more than it can account for, so selling
     * what it can account for realizes a loss that is really a write-off of the unrecorded part. That is
     * the truthful accounting, and it is the kind of truth that has to be said out loud rather than left
     * to look like a trading loss.
     */
    buysWithoutUnits: number;
}

/** The `positions.` line of an entry, and what it moved. */
function positionLine(tx: LedgerTx): { asset: string; amount: bigint } | null {
    const line = tx.lines.find((l) => l.account.startsWith("positions."));
    if (line === undefined) return null;
    return { asset: line.account.slice("positions.".length).toLowerCase(), amount: line.amount };
}

export function positionsFromLedger(txs: readonly LedgerTx[]): Map<string, Position> {
    const out = new Map<string, Position>();
    const get = (asset: string): Position => {
        let p = out.get(asset);
        if (p === undefined) {
            p = { asset, units: 0n, costUsdcIn: 0n, realizedUsdc: 0n, buys: 0, sells: 0, buysWithoutUnits: 0 };
            out.set(asset, p);
        }
        return p;
    };

    for (const tx of txs) {
        if (tx.type !== "PURCHASE_SETTLED" && tx.type !== "SALE_SETTLED") continue;
        const line = positionLine(tx);
        if (line === null) {
            throw new Error(`entry ${tx.id} is a ${tx.type} with no positions line; the book is malformed`);
        }
        const p = get(line.asset);
        p.costUsdcIn += line.amount;
        if (tx.type === "PURCHASE_SETTLED") {
            p.buys += 1;
            // A fill booked before units were recorded leaves the position valued but uncountable. It is
            // not an error in the books; `unsellable` and `partlyUnrecorded` are what say so.
            if (tx.units === undefined) p.buysWithoutUnits += 1;
            p.units += tx.units ?? 0n;
        } else {
            p.sells += 1;
            p.units += tx.units ?? 0n; // negative on a sale
            const pnl = tx.lines.find((l) => l.account === "pnl.realized");
            // the account is credited on a gain, so the gain is the negative of the line
            if (pnl !== undefined) p.realizedUsdc -= pnl.amount;
        }
    }
    return out;
}

/**
 * Why a position cannot be acted on, or null when it can.
 *
 * The agent must never sell a position it cannot count. A fill booked before units were recorded leaves
 * `units` at zero against a real cost, and selling "all zero units" of it would book the whole cost
 * basis as a loss while disposing of nothing.
 */
export function unsellable(p: Position): string | null {
    if (p.units <= 0n && p.costUsdcIn > 0n) {
        return "the units bought were never recorded, so this position cannot be valued or sold";
    }
    if (p.units <= 0n) return "nothing is held";
    if (p.costUsdcIn <= 0n) return "no cost was recorded against these units";
    return null;
}

/**
 * Said when part of a position's cost bought units nobody wrote down, or null when it did not.
 *
 * Distinct from `unsellable`: this position can be sold, and the units it reports are real. What is
 * wrong is the cost it will be measured against, so the gain or loss a sale realizes is not a
 * statement about the market.
 */
export function partlyUnrecorded(p: Position): string | null {
    if (p.buysWithoutUnits === 0 || p.units <= 0n) return null;
    return (
        `${p.buysWithoutUnits} of ${p.buys} buys recorded no units, so this cost basis covers more than ` +
        "the units shown. Selling realizes a loss that is a write-off of the unrecorded part, not a market move."
    );
}

/**
 * What a position is worth at a price, and how far it has moved from what was paid.
 *
 * `price` is USDC minor units per one whole token, the same unit the approval `PriceMap` uses, so a
 * quote can be passed straight in. Returns null when the position cannot be valued at all, rather than
 * a zero that would read as a total loss.
 */
export function valuePosition(
    p: Position,
    price: bigint,
    decimals: number,
): { valueUsdc: bigint; moveBps: number } | null {
    if (unsellable(p) !== null || price <= 0n) return null;
    const valueUsdc = (p.units * price) / 10n ** BigInt(decimals);
    // Basis points of movement against what was paid. Rounded toward zero, which is the conservative
    // direction for both a take-profit and a stop-loss: a position exactly on the line does not trigger.
    const moveBps = Number(((valueUsdc - p.costUsdcIn) * 10_000n) / p.costUsdcIn);
    return { valueUsdc, moveBps };
}

/**
 * The cost basis of part of a position, in proportion to the units being sold.
 *
 * Rounded down, and the whole remaining basis is taken when the whole position goes, so a full exit
 * always leaves `positions.<asset>` at exactly zero rather than a rounding dust that would sit on the
 * books for ever claiming the agent still owns something.
 */
export function costOfUnits(p: Position, units: bigint): bigint {
    if (units <= 0n) throw new Error("units must be positive");
    if (units > p.units) throw new Error(`cannot take the cost of ${units} units from a position of ${p.units}`);
    if (units === p.units) return p.costUsdcIn;
    return (p.costUsdcIn * units) / p.units;
}


/**
 * One source of a position's cost basis: the brief and theme that put money into it.
 *
 * A position is rarely built from one commitment. The same token can be bought under two themes of one
 * brief, under two briefs, and by a demo that named neither, and all of it lands in a single
 * `positions.<asset>` balance. When that position is sold, the basis leaving has to leave the places it
 * came from, or the books would show money still committed to a brief whose position has been closed.
 */
export interface CostBucket {
    briefId?: string;
    theme?: string;
    /** Basis still sitting in this bucket, after any earlier sales took their share. */
    costUsdcIn: bigint;
}

const bucketKey = (briefId?: string, theme?: string): string => `${briefId ?? ""}\u0000${theme ?? ""}`;

/**
 * Where one token's remaining cost basis came from, biggest first.
 *
 * Earlier sales are netted out of their own buckets, so this is what is left to unwind rather than what
 * was ever bought. Buckets that have been emptied are dropped.
 */
export function costBuckets(txs: readonly LedgerTx[], asset: string): CostBucket[] {
    const want = asset.toLowerCase();
    const out = new Map<string, CostBucket>();
    for (const tx of txs) {
        if (tx.type !== "PURCHASE_SETTLED" && tx.type !== "SALE_SETTLED") continue;
        const line = positionLine(tx);
        if (line === null || line.asset !== want) continue;
        const key = bucketKey(tx.briefId, tx.theme);
        const bucket = out.get(key) ?? {
            ...(tx.briefId !== undefined && { briefId: tx.briefId }),
            ...(tx.theme !== undefined && { theme: tx.theme }),
            costUsdcIn: 0n,
        };
        bucket.costUsdcIn += line.amount; // negative on a sale
        out.set(key, bucket);
    }
    return [...out.values()]
        .filter((b) => b.costUsdcIn > 0n)
        .sort((a, b) => (a.costUsdcIn < b.costUsdcIn ? 1 : a.costUsdcIn > b.costUsdcIn ? -1 : 0));
}
