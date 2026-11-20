import { isQuoteFresh, priceOf, type Quote } from "./quote";
import { navStatus, tradability, type TokenRecord } from "./tokens";
import type { Leg } from "./policy";

export type GateLevel = "ok" | "warn" | "block";

export interface Gate {
    asset: string;
    symbol: string;
    name: string;
    level: GateLevel;
    detail: string;
}

export interface GateLimits {
    maxQuoteAgeSeconds: number;
    maxNavDeviationBps: number;
    navMaxAgeSeconds: number;
    minLiquidityScore: number; // 0 to 5
}

/** Starting values: recommendations to tune, not facts. */
export const DEFAULT_GATE_LIMITS: GateLimits = {
    maxQuoteAgeSeconds: 25,
    maxNavDeviationBps: 300,
    navMaxAgeSeconds: 3600,
    minLiquidityScore: 2,
};

export interface PreTradeInput {
    legs: readonly Leg[];
    quotes: ReadonlyMap<string, Quote>;
    tokens: ReadonlyMap<string, TokenRecord>; // trusted tokens only
    liquidity: ReadonlyMap<string, number>;
    now: Date;
    limits?: GateLimits;
}

/**
 * Market checks run immediately before execution. A block stops the trade.
 * A stale or missing NAV only warns, because NAV is a reference that can lag for hours.
 */
export function preTradeChecks(i: PreTradeInput): Gate[] {
    const limits = i.limits ?? DEFAULT_GATE_LIMITS;
    const gates: Gate[] = [];
    const seen = new Set<string>();

    for (const leg of i.legs) {
        const asset = leg.asset.toLowerCase();
        if (seen.has(asset)) continue;
        seen.add(asset);
        const add = (name: string, level: GateLevel, detail: string) =>
            gates.push({ asset, symbol: leg.symbol, name, level, detail });

        const token = i.tokens.get(asset);
        if (!token) {
            add("trusted", "block", "not a trusted token");
            continue;
        }

        const trade = tradability(token);
        if (trade.ok) add("tradable", "ok", "no pause flags, multiplier present");
        else for (const r of trade.reasons) add("tradable", "block", r);

        const liq = i.liquidity.get(asset) ?? 0;
        if (liq >= limits.minLiquidityScore) add("liquidity", "ok", `score ${liq}`);
        else add("liquidity", "block", `score ${liq} is below the minimum ${limits.minLiquidityScore}`);

        const quote = i.quotes.get(asset);
        if (!quote) {
            add("quote", "block", "no quote");
            continue;
        }
        if (quote.timestamp === null) {
            add("quote", "block", "quote has no timestamp");
        } else if (!isQuoteFresh(quote, i.now, limits.maxQuoteAgeSeconds)) {
            const age = Math.round(i.now.getTime() / 1000 - quote.timestamp);
            add("quote", "block", `quote is ${age}s old (limit ${limits.maxQuoteAgeSeconds}s)`);
        } else {
            add("quote", "ok", "fresh");
        }

        const status = navStatus(token, i.now, limits.navMaxAgeSeconds);
        if (status === "missing") {
            add("nav", "warn", "no NAV reference, deviation check skipped");
        } else if (status === "stale") {
            const mins = Math.round((i.now.getTime() - Date.parse(token.navUpdatedAt!)) / 60_000);
            add("nav", "warn", `NAV is ${mins} min old, deviation check skipped`);
        } else {
            const px = Number(priceOf(quote, token.decimals)) / 1e6;
            const dev = Math.round(Math.abs(px / token.navPrice! - 1) * 10_000);
            if (dev > limits.maxNavDeviationBps) {
                add("nav", "block", `quote is ${dev} bps from NAV (limit ${limits.maxNavDeviationBps} bps)`);
            } else {
                add("nav", "ok", `${dev} bps from NAV`);
            }
        }
    }
    return gates;
}

export const blockReasons = (gates: readonly Gate[]): string[] =>
    gates.filter((g) => g.level === "block").map((g) => `${g.symbol} ${g.name}: ${g.detail}`);

export const warnings = (gates: readonly Gate[]): string[] =>
    gates.filter((g) => g.level === "warn").map((g) => `${g.symbol} ${g.name}: ${g.detail}`);