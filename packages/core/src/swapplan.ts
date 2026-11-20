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
