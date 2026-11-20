import { describe, it, expect } from "vitest";
import { preTradeChecks, blockReasons, warnings, DEFAULT_GATE_LIMITS } from "../src/gates";
import type { Quote } from "../src/quote";
import type { TokenRecord } from "../src/tokens";
import type { Leg } from "../src/policy";
import { BASE_USDC } from "../src/liquidity";
import { parseUsdc as u } from "../src/money";
import { NVDA, MSFT } from "./fixtures";

const NOW = new Date("2026-11-20T15:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

const token = (address: string, symbol: string, over: Partial<TokenRecord> = {}): TokenRecord => ({
    address, symbol, name: symbol, decimals: 18, isin: null, multiplier: 1, pausedFeatures: [],
    navPrice: 200, navUpdatedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), totalSupply: null, ...over,
});

// 1 USDC buys 0.005 tokens, so the quoted price is 200 USDC per token
const quote = (address: string, over: Partial<Quote> = {}): Quote => ({
    tokenIn: BASE_USDC, tokenOut: address, amountIn: 1_000_000n, amountOut: 5_000_000_000_000_000n,
    amountInUsd: 1, amountOutUsd: 0.999, gasUsd: 0.0035, l1FeeUsd: null,
    routerAddress: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", routeId: "r", timestamp: nowSec - 3,
    routeSummary: {}, ...over,
});

const leg = (asset: string, symbol: string): Leg => ({ asset, symbol, theme: "t", usdcIn: u("0.2"), maxSlippageBps: 100 });

const run = (over: {
    tokens?: TokenRecord[]; quotes?: Quote[]; liquidity?: [string, number][]; limits?: typeof DEFAULT_GATE_LIMITS;
} = {}) => {
    const tokens = over.tokens ?? [token(NVDA, "NVDAc")];
    const quotes = over.quotes ?? [quote(NVDA)];
    return preTradeChecks({
        legs: [leg(NVDA, "NVDAc")],
        tokens: new Map(tokens.map((t) => [t.address, t])),
        quotes: new Map(quotes.map((q) => [q.tokenOut, q])),
        liquidity: new Map(over.liquidity ?? [[NVDA, 4]]),
        now: NOW,
        ...(over.limits && { limits: over.limits }),
    });
};

describe("pre-trade gates", () => {
    it("passes a healthy leg with no blocks or warnings", () => {
        const g = run();
        expect(g.every((x) => x.level === "ok")).toBe(true);
        expect(blockReasons(g)).toEqual([]);
        expect(warnings(g)).toEqual([]);
    });

    it("blocks a token that is not trusted", () => {
        expect(blockReasons(run({ tokens: [] }))).toEqual(["NVDAc trusted: not a trusted token"]);
    });

    it("blocks paused tokens and a missing multiplier", () => {
        expect(blockReasons(run({ tokens: [token(NVDA, "NVDAc", { pausedFeatures: [1] })] })).join(" ")).toMatch(/paused/);
        expect(blockReasons(run({ tokens: [token(NVDA, "NVDAc", { multiplier: null })] })).join(" ")).toMatch(/multiplier/);
    });

    it("blocks a stale quote, a quote without a timestamp, and a missing quote", () => {
        expect(blockReasons(run({ quotes: [quote(NVDA, { timestamp: nowSec - 40 })] }))).toEqual([
            "NVDAc quote: quote is 40s old (limit 25s)",
        ]);
        expect(blockReasons(run({ quotes: [quote(NVDA, { timestamp: null })] }))).toEqual([
            "NVDAc quote: quote has no timestamp",
        ]);
        expect(blockReasons(run({ quotes: [] }))).toEqual(["NVDAc quote: no quote"]);
    });

    it("blocks thin or unknown liquidity", () => {
        expect(blockReasons(run({ liquidity: [[NVDA, 1]] }))).toEqual(["NVDAc liquidity: score 1 is below the minimum 2"]);
        expect(blockReasons(run({ liquidity: [] })).length).toBe(1);
    });

    it("only warns when NAV is missing or stale, even if the price is far from it", () => {
        const missing = run({ tokens: [token(NVDA, "NVDAc", { navPrice: null, navUpdatedAt: null })] });
        expect(blockReasons(missing)).toEqual([]);
        expect(warnings(missing)).toEqual(["NVDAc nav: no NAV reference, deviation check skipped"]);

        const old = new Date(NOW.getTime() - 90 * 60_000).toISOString();
        const stale = run({ tokens: [token(NVDA, "NVDAc", { navPrice: 100, navUpdatedAt: old })] });
        expect(blockReasons(stale)).toEqual([]);
        expect(warnings(stale)).toEqual(["NVDAc nav: NAV is 90 min old, deviation check skipped"]);
    });

    it("blocks when a fresh NAV is too far from the quote, and passes within the limit", () => {
        // quote is 200; NAV 190 is about 526 bps away, NAV 198 is 101 bps away
        expect(blockReasons(run({ tokens: [token(NVDA, "NVDAc", { navPrice: 190 })] }))).toEqual([
            "NVDAc nav: quote is 526 bps from NAV (limit 300 bps)",
        ]);
        const ok = run({ tokens: [token(NVDA, "NVDAc", { navPrice: 198 })] });
        expect(blockReasons(ok)).toEqual([]);
        expect(ok.find((x) => x.name === "nav")!.detail).toBe("101 bps from NAV");
    });

    it("checks each distinct token once", () => {
        const g = preTradeChecks({
            legs: [leg(NVDA, "NVDAc"), leg(NVDA, "NVDAc"), leg(MSFT, "MSFTc")],
            tokens: new Map([[NVDA, token(NVDA, "NVDAc")], [MSFT, token(MSFT, "MSFTc")]]),
            quotes: new Map([[NVDA, quote(NVDA)], [MSFT, quote(MSFT)]]),
            liquidity: new Map([[NVDA, 4], [MSFT, 4]]),
            now: NOW,
        });
        expect(g.filter((x) => x.name === "quote").map((x) => x.symbol)).toEqual(["NVDAc", "MSFTc"]);
    });
});