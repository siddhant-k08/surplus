import { describe, it, expect } from "vitest";
import { themeDrift } from "../src/rebalance";
import type { ThemeHolding } from "../src/positions";
import { parseUsdc as u } from "../src/money";
import { baseTerms, NVDA, MSFT, META } from "./fixtures";

const ONE = 10n ** 18n;

/** A holding of `tokens` whole tokens under one theme, bought at 0.10 USDC each. */
const held = (theme: string | null, asset: string, tokens: bigint): ThemeHolding => ({
    theme,
    asset,
    units: tokens * ONE,
    costUsdcIn: u("0.10") * tokens,
});

const decimals = new Map([[NVDA, 18], [MSFT, 18], [META, 18]]);
const at = (prices: Record<string, bigint>) => new Map(Object.entries(prices));

// Every token priced at 0.10, so a theme's weight is just how many tokens it holds.
const FLAT = at({ [NVDA]: 100_000n, [MSFT]: 100_000n, [META]: 100_000n });

describe("how far each theme has drifted from its target", () => {
    it("renormalises targets over the themes that actually hold something", () => {
        // The mandate wants 50/30/20 but the third theme is a gap, so nothing was ever bought for it.
        // Against the whole 10000 bps, ai-compute at 62.5% would look 1250 bps over and get trimmed for
        // no reason. Renormalised over the two funded themes, 62.5/37.5 is exactly on target.
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 3n)],
            prices: FLAT,
            decimals,
            terms: baseTerms({ rebalanceBandBps: 100 }),
        });
        const ai = r.themes.find((t) => t.theme === "ai-compute")!;
        const pg = r.themes.find((t) => t.theme === "platform-giants")!;
        expect(ai.actualBps).toBe(6250);
        expect(ai.targetBps).toBe(6250);
        expect(ai.driftBps).toBe(0);
        expect(pg.driftBps).toBe(0);
        expect(r.themes.every((t) => !t.overBand)).toBe(true);
        expect(r.totalUsdc).toBe(u("0.80"));
    });

    it("sees a theme that has run up past its band", () => {
        // ai-compute's token triples; nothing else moves.
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 3n)],
            prices: at({ [NVDA]: 300_000n, [META]: 100_000n }),
            decimals,
            terms: baseTerms({ rebalanceBandBps: 500 }),
        });
        const ai = r.themes[0]!;
        expect(ai.theme).toBe("ai-compute");
        expect(ai.valueUsdc).toBe(u("1.50"));
        expect(ai.actualBps).toBe(8333);
        expect(ai.targetBps).toBe(6250);
        expect(ai.driftBps).toBe(2083);
        expect(ai.overBand).toBe(true);
        // what has to go to put it back on target: 1.50 held against 62.5% of 1.80
        expect(ai.excessUsdc).toBe(u("1.50") - u("1.125"));
    });

    it("leaves a drift inside the band alone", () => {
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 3n)],
            prices: at({ [NVDA]: 105_000n, [META]: 100_000n }),
            decimals,
            terms: baseTerms({ rebalanceBandBps: 500 }),
        });
        const ai = r.themes.find((t) => t.theme === "ai-compute")!;
        expect(ai.driftBps).toBeGreaterThan(0);
        expect(ai.driftBps).toBeLessThan(500);
        expect(ai.overBand).toBe(false);
    });

    it("never trims a theme that is below its target", () => {
        // Selling the under-weight side would make the drift worse, not better.
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 3n)],
            prices: at({ [NVDA]: 100_000n, [META]: 300_000n }),
            decimals,
            terms: baseTerms({ rebalanceBandBps: 100 }),
        });
        const ai = r.themes.find((t) => t.theme === "ai-compute")!;
        expect(ai.driftBps).toBeLessThan(0);
        expect(ai.excessUsdc).toBe(0n);
        expect(ai.overBand).toBe(false);
    });

    it("does nothing at all when the mandate states no band", () => {
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 9n), held("platform-giants", META, 1n)],
            prices: FLAT,
            decimals,
            terms: baseTerms(),
        });
        // the drift is reported, because an owner should be able to see it
        expect(r.themes.find((t) => t.theme === "ai-compute")!.driftBps).toBeGreaterThan(0);
        // but nothing is over band, because there is no band
        expect(r.themes.every((t) => !t.overBand)).toBe(true);
    });

    it("will not trim an excess too small to be worth a trade", () => {
        const terms = baseTerms({ rebalanceBandBps: 1, minTradeUsdc: u("0.50") });
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 2n)],
            prices: FLAT,
            decimals,
            terms,
        });
        const ai = r.themes.find((t) => t.theme === "ai-compute")!;
        expect(ai.driftBps).toBeGreaterThan(1);
        expect(ai.excessUsdc).toBeLessThan(u("0.50"));
        expect(ai.overBand).toBe(false);
    });

    it("keeps holdings under no theme out of the weights entirely", () => {
        // They belong to no target, so counting them would dilute every theme's share and invent a
        // drift out of money the mandate never had an opinion about.
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 3n), held(null, MSFT, 4n)],
            prices: FLAT,
            decimals,
            terms: baseTerms({ rebalanceBandBps: 100 }),
        });
        expect(r.totalUsdc).toBe(u("0.80"));
        expect(r.untargetedUsdc).toBe(u("0.40"));
        expect(r.themes.every((t) => t.driftBps === 0)).toBe(true);
    });

    it("keeps a theme the mandate no longer funds out of the weights too", () => {
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("platform-giants", META, 3n), held("dropped-theme", MSFT, 4n)],
            prices: FLAT,
            decimals,
            terms: baseTerms({ rebalanceBandBps: 100 }),
        });
        expect(r.untargetedUsdc).toBe(u("0.40"));
        expect(r.themes.map((t) => t.theme).sort()).toEqual(["ai-compute", "platform-giants"]);
    });

    it("leaves a holding it cannot price out of both the theme and the total", () => {
        // A missing quote must never make a theme look smaller than it is and trigger a trim elsewhere.
        const r = themeDrift({
            holdings: [held("ai-compute", NVDA, 5n), held("ai-compute", MSFT, 5n), held("platform-giants", META, 3n)],
            prices: at({ [NVDA]: 100_000n, [META]: 100_000n }), // no price for MSFT
            decimals,
            terms: baseTerms({ rebalanceBandBps: 100 }),
        });
        expect(r.totalUsdc).toBe(u("0.80"));
        expect(r.themes.find((t) => t.theme === "ai-compute")!.valueUsdc).toBe(u("0.50"));
    });

    it("answers empty rather than dividing by zero when nothing is held", () => {
        const r = themeDrift({ holdings: [], prices: FLAT, decimals, terms: baseTerms({ rebalanceBandBps: 100 }) });
        expect(r).toEqual({ themes: [], totalUsdc: 0n, untargetedUsdc: 0n });
    });
});
