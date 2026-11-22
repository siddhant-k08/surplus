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
    readonly parts: readonly { readonly theme: string; readonly usdcIn: bigint }[];
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

    const byAsset = new Map<string, Leg[]>();
    for (const leg of legs) {
        const key = leg.asset.toLowerCase();
        const list = byAsset.get(key);
        if (list) list.push(leg);
        else byAsset.set(key, [leg]);
    }

    const orders: SwapOrder[] = [];
    for (const [asset, group] of byAsset) {
        const symbol = group[0]!.symbol;
        const maxSlippageBps = Math.min(...group.map((l) => l.maxSlippageBps));

        // fill orders up to the cap, in leg order, splitting a leg across orders only when it has to be
        let parts: { theme: string; usdcIn: bigint }[] = [];
        let running = 0n;
        const flush = (): void => {
            if (running === 0n) return;
            orders.push({ asset, symbol, usdcIn: running, maxSlippageBps, parts });
            parts = [];
            running = 0n;
        };
        for (const leg of group) {
            let left = leg.usdcIn;
            while (left > 0n) {
                const room = maxTradeUsdc - running;
                if (room === 0n) {
                    flush();
                    continue;
                }
                const take = left < room ? left : room;
                parts.push({ theme: leg.theme, usdcIn: take });
                running += take;
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


/**
 * Attributes what each swap returned back to the legs that paid for it.
 *
 * `swapPlan` groups legs by token and cuts them at the trade cap, so one swap can cover several legs
 * and one leg can be spread over several swaps. The ledger keeps an entry per leg, so the quantities
 * have to go back the way the money came out. The plan consumes a token's legs in order, which is what
 * makes this recoverable: the running total of what has been spent on a token says which leg the next
 * slice belongs to.
 *
 * `filled` is keyed by position in the plan. An order missing from it did not execute, and its legs are
 * absent from the result rather than credited with a quantity they never received.
 */
export function attributeFills(
    legs: readonly Leg[],
    plan: readonly SwapOrder[],
    filled: ReadonlyMap<number, bigint>,
): Map<number, bigint> {
    const out = new Map<number, bigint>();
    const spentPerAsset = new Map<string, bigint>();

    for (const [position, order] of plan.entries()) {
        const key = order.asset.toLowerCase();
        const amountOut = filled.get(position);
        const shares = amountOut === undefined ? null : splitFill(amountOut, order.parts.map((p) => p.usdcIn));

        for (const [k, part] of order.parts.entries()) {
            const offset = spentPerAsset.get(key) ?? 0n;
            if (shares !== null) {
                const index = legAt(legs, key, offset);
                if (index < 0) throw new Error(`the plan spends more on ${order.symbol} than its legs do`);
                out.set(index, (out.get(index) ?? 0n) + shares[k]!);
            }
            spentPerAsset.set(key, offset + part.usdcIn);
        }
    }
    return out;
}

/** The leg of this token whose slice contains the given offset into the token's total spend. */
function legAt(legs: readonly Leg[], asset: string, offset: bigint): number {
    let seen = 0n;
    for (const [index, leg] of legs.entries()) {
        if (leg.asset.toLowerCase() !== asset) continue;
        const end = seen + leg.usdcIn;
        if (offset < end) return index;
        seen = end;
    }
    return -1;
}
