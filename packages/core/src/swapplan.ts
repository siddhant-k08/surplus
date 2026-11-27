import type { Leg } from "./policy";
import { formatUsdc } from "./money";

/**
 * One onchain swap. `parts` records which themes paid for it and how much each contributed, so a merged
 * swap stays attributable to the themes the mandate funded.
 */
export interface SwapOrder {
    readonly asset: string;
    readonly symbol: string;
    readonly usdcIn: bigint;
    readonly maxSlippageBps: number;
    readonly parts: readonly {
        readonly theme: string;
        readonly usdcIn: bigint;
        /** Sell only: the units of this leg that went into this swap. */
        readonly unitsIn?: bigint;
    }[];
    /** Absent for a buy, so an order that predates the sell path is unchanged. */
    readonly side?: "sell";
    /** Sell only: the token units this one swap disposes of. */
    readonly unitsIn?: bigint;
}

/**
 * Groups legs that buy the same token into one swap each, so the agent pays gas once per token instead of
 * once per theme. Allocation is unchanged: every leg's money still goes to the token its theme chose, and
 * the per-theme totals are preserved in `parts`.
 *
 * Each order is capped at `maxTradeUsdc` and split into further orders when the merged total would exceed it,
 * because that term is the owner's limit on a single trade and merging must not quietly widen it.
 * Slippage for a merged order is the tightest of its legs, never the loosest.
 */
export function swapPlan(legs: readonly Leg[], maxTradeUsdc: bigint): SwapOrder[] {
    if (maxTradeUsdc <= 0n) throw new Error("maxTradeUsdc must be positive");

    // Grouped by token *and* direction. Merging is what makes the gas worth paying, but merging a buy
    // and a sale of the same token would net them into one swap that does neither, and would lose the
    // units the sale is supposed to dispose of.
    const byAsset = new Map<string, Leg[]>();
    for (const leg of legs) {
        const key = `${leg.asset.toLowerCase()}:${leg.side ?? "buy"}`;
        const list = byAsset.get(key);
        if (list) list.push(leg);
        else byAsset.set(key, [leg]);
    }

    const orders: SwapOrder[] = [];
    for (const group of byAsset.values()) {
        const first = group[0]!;
        const asset = first.asset.toLowerCase();
        const symbol = first.symbol;
        const sell = first.side === "sell";
        const maxSlippageBps = Math.min(...group.map((l) => l.maxSlippageBps));

        // fill orders up to the cap, in leg order, splitting a leg across orders only when it has to be
        let parts: { theme: string; usdcIn: bigint; unitsIn?: bigint }[] = [];
        let running = 0n;
        let units = 0n;
        const flush = (): void => {
            if (running === 0n) return;
            orders.push({
                asset, symbol, usdcIn: running, maxSlippageBps, parts,
                ...(sell && { side: "sell" as const, unitsIn: units }),
            });
            parts = [];
            running = 0n;
            units = 0n;
        };
        for (const leg of group) {
            let left = leg.usdcIn;
            const legUnits = leg.unitsIn ?? 0n;
            let unitsLeft = legUnits;
            while (left > 0n) {
                const room = maxTradeUsdc - running;
                if (room === 0n) {
                    flush();
                    continue;
                }
                const take = left < room ? left : room;
                running += take;
                // Units follow the notional they were cut with, and the last slice takes what is left so
                // a split leg disposes of exactly the units it was asked to and never a rounding less.
                const takeUnits = take === left ? unitsLeft : (legUnits * take) / leg.usdcIn;
                units += takeUnits;
                parts.push({ theme: leg.theme, usdcIn: take, ...(sell && { unitsIn: takeUnits }) });
                unitsLeft -= takeUnits;
                left -= take;
            }
        }
        flush();
    }
    return orders;
}

/** Total USDC a plan spends. Must equal the total of the legs it came from. */
export const swapPlanTotal = (orders: readonly SwapOrder[]): bigint =>
    orders.reduce((a, o) => a + o.usdcIn, 0n);

/** One readable line per order, naming the themes that paid for it. */
export function describeSwapPlan(orders: readonly SwapOrder[]): string[] {
    return orders.map((o) => {
        const parts = o.parts.map((p) => `${p.theme} ${formatUsdc(p.usdcIn)}`).join(" + ");
        return `${o.symbol.padEnd(7)} ${formatUsdc(o.usdcIn)} USDC (${parts})`;
    });
}


/**
 * Splits what a swap actually returned back across the legs that paid for it.
 *
 * One swap buys one token for several themes at once, which is what makes the gas worth paying, but the
 * ledger keeps one entry per leg so a position stays attributable to the themes that funded it. The
 * quantity that came back therefore has to be divided the way the money was: in proportion to what each
 * leg put in.
 *
 * Every unit is accounted for. Dividing rounds down, so the remainder goes to the largest contributor
 * rather than being dropped: tokens that exist in the wallet and in no entry would make the books
 * disagree with the chain, which is the one thing they must never do.
 */
export function splitFill(amountOut: bigint, parts: readonly bigint[]): bigint[] {
    if (amountOut < 0n) throw new Error("amountOut must not be negative");
    // the specific complaint first: a negative part makes the total meaningless as well as wrong
    if (parts.some((p) => p < 0n)) throw new Error("a part must not be negative");
    const total = parts.reduce((a, p) => a + p, 0n);
    if (total <= 0n) throw new Error("the parts must add up to more than nothing");

    const shares = parts.map((p) => (amountOut * p) / total);
    const remainder = amountOut - shares.reduce((a, s) => a + s, 0n);
    if (remainder > 0n) {
        let largest = 0;
        for (const [i, p] of parts.entries()) if (p > parts[largest]!) largest = i;
        shares[largest] = shares[largest]! + remainder;
    }
    return shares;
}


/** What one swap did for one leg. */
export interface SwapShare {
    /** Index of the leg in the proposal. */
    readonly leg: number;
    /** What came back to this leg: token units on a buy, USDC minor units on a sale. */
    readonly quantity: bigint;
    /** The part of the leg's notional this swap covered. */
    readonly usdcIn: bigint;
    /** Sell only: the units of the leg this swap disposed of. */
    readonly unitsIn?: bigint;
}

/**
 * Attributes what one swap returned back to the legs that paid for it.
 *
 * `swapPlan` groups legs by token and direction and cuts them at the trade cap, so one swap can cover
 * several legs and one leg can be spread over several swaps. The plan consumes a group's legs in order,
 * which is what makes this recoverable from the plan alone: what the earlier orders of the same group
 * spent says which leg each slice of this one belongs to. Nothing about the other swaps' outcomes is
 * needed, so a swap confirmed late is attributed exactly as it would have been at the time.
 */
export function orderShares(
    legs: readonly Leg[],
    plan: readonly SwapOrder[],
    position: number,
    amountOut: bigint,
): SwapShare[] {
    const order = plan[position];
    if (order === undefined) throw new Error(`the plan has no order at position ${position}`);
    const key = order.asset.toLowerCase();
    const side = order.side ?? "buy";

    let offset = 0n;
    for (const earlier of plan.slice(0, position)) {
        if (earlier.asset.toLowerCase() === key && (earlier.side ?? "buy") === side) offset += earlier.usdcIn;
    }

    const quantities = splitFill(amountOut, order.parts.map((p) => p.usdcIn));
    return order.parts.map((part, k) => {
        const leg = legAt(legs, key, side, offset);
        if (leg < 0) throw new Error(`the plan spends more on ${order.symbol} than its legs do`);
        offset += part.usdcIn;
        return {
            leg,
            quantity: quantities[k]!,
            usdcIn: part.usdcIn,
            ...(part.unitsIn !== undefined && { unitsIn: part.unitsIn }),
        };
    });
}

/** The leg of this token and direction whose slice contains the offset into the group's total. */
function legAt(legs: readonly Leg[], asset: string, side: string, offset: bigint): number {
    let seen = 0n;
    for (const [index, leg] of legs.entries()) {
        if (leg.asset.toLowerCase() !== asset || (leg.side ?? "buy") !== side) continue;
        const end = seen + leg.usdcIn;
        if (offset < end) return index;
        seen = end;
    }
    return -1;
}
