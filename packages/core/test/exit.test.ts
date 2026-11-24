import { describe, it, expect } from "vitest";
import { exitPlan } from "../src/exit";
import type { Position } from "../src/positions";
import { parseUsdc as u } from "../src/money";
import { baseTerms, NVDA, MSFT, META } from "./fixtures";

const ONE = 10n ** 18n;

/** A position bought at 0.10 USDC a token. */
const held = (asset: string, tokens: bigint, cost = u("0.10")): Position => ({
    asset,
    units: tokens * ONE,
    costUsdcIn: cost * tokens,
    realizedUsdc: 0n,
    buys: 1,
    sells: 0,
    buysWithoutUnits: 0,
});

const THEME_OF: Record<string, string> = { [NVDA]: "ai-compute", [MSFT]: "ai-compute", [META]: "platform-giants" };

/**
 * A world where each token is held under exactly one theme.
 *
 * `holdings` is what a sale actually leaves, and `positions` is what the price rules act on, so the
 * fixture derives one from the other rather than letting them drift apart.
 */
const world = (positions: Position[], prices: Record<string, bigint>) => ({
    positions: new Map(positions.map((p) => [p.asset, p])),
    holdings: positions.map((p) => ({
        theme: THEME_OF[p.asset] ?? null,
        asset: p.asset,
        units: p.units,
        costUsdcIn: p.costUsdcIn,
    })),
    prices: new Map(Object.entries(prices)),
    decimals: new Map([[NVDA, 18], [MSFT, 18], [META, 18]]),
    symbols: new Map([[NVDA, "NVDAc"], [MSFT, "MSFTc"], [META, "METAc"]]),
});

describe("when the agent sells", () => {
    it("proposes nothing at all when the mandate states no exit", () => {
        // An owner who has not said when to sell has not authorised selling. Silence is not permission.
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 1_000_000n }),
            terms: baseTerms(),
        });
        expect(r.legs).toEqual([]);
        expect(r.candidates).toEqual([]);
    });

    it("takes profit once a position is up by the stated amount", () => {
        const r = exitPlan({
            // bought at 0.10, now 0.13 a token: up 3000 bps
            ...world([held(NVDA, 2n)], { [NVDA]: 130_000n }),
            terms: baseTerms({ takeProfitBps: 2000 }),
        });
        expect(r.candidates).toHaveLength(1);
        expect(r.candidates[0]!.reason).toBe("take_profit");
        expect(r.candidates[0]!.moveBps).toBe(3000);
        expect(r.candidates[0]!.valueUsdc).toBe(u("0.26"));
        expect(r.candidates[0]!.costUsdc).toBe(u("0.20"));
        expect(r.legs[0]).toMatchObject({ side: "sell", unitsIn: 2n * ONE, usdcIn: u("0.26"), theme: "ai-compute" });
    });

    it("holds a position that has not reached the threshold", () => {
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 110_000n }),
            terms: baseTerms({ takeProfitBps: 2000 }),
        });
        expect(r.legs).toEqual([]);
        expect(r.skipped).toEqual([]);
    });

    it("stops a loss once a position is down by the stated amount", () => {
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 70_000n }),
            terms: baseTerms({ stopLossBps: 2500 }),
        });
        expect(r.candidates[0]!.reason).toBe("stop_loss");
        expect(r.candidates[0]!.moveBps).toBe(-3000);
    });

    it("does not confuse the two directions", () => {
        // a mandate with only a take profit must not sell into a fall, and the reverse
        const up = world([held(NVDA, 2n)], { [NVDA]: 150_000n });
        const down = world([held(NVDA, 2n)], { [NVDA]: 50_000n });
        expect(exitPlan({ ...up, terms: baseTerms({ stopLossBps: 2000 }) }).legs).toEqual([]);
        expect(exitPlan({ ...down, terms: baseTerms({ takeProfitBps: 2000 }) }).legs).toEqual([]);
    });

    it("sells only what has moved, leaving the rest alone", () => {
        const r = exitPlan({
            ...world(
                [held(NVDA, 2n), held(MSFT, 2n), held(META, 2n)],
                { [NVDA]: 130_000n, [MSFT]: 100_000n, [META]: 60_000n },
            ),
            terms: baseTerms({ takeProfitBps: 2000, stopLossBps: 2500 }),
        });
        expect(r.candidates.map((c) => [c.symbol, c.reason])).toEqual([
            ["NVDAc", "take_profit"],
            ["METAc", "stop_loss"],
        ]);
    });

    it("puts the biggest exit first", () => {
        const r = exitPlan({
            ...world([held(NVDA, 1n), held(MSFT, 5n)], { [NVDA]: 200_000n, [MSFT]: 200_000n }),
            terms: baseTerms({ takeProfitBps: 2000 }),
        });
        expect(r.candidates.map((c) => c.symbol)).toEqual(["MSFTc", "NVDAc"]);
        expect(r.legs.map((l) => l.symbol)).toEqual(["MSFTc", "NVDAc"]);
    });
});

describe("what the exit refuses, and says so", () => {
    it("will not sell for less than the mandate's smallest trade", () => {
        const r = exitPlan({
            // a position worth 0.013 against a 0.10 minimum: the fees would eat it
            ...world([held(NVDA, 1n, u("0.01"))], { [NVDA]: 13_000n }),
            terms: baseTerms({ takeProfitBps: 2000 }),
        });
        expect(r.legs).toEqual([]);
        expect(r.skipped[0]!.why).toMatch(/below the mandate's minimum trade/);
    });

    it("will not act on a position whose units were never recorded", () => {
        const p: Position = { asset: NVDA, units: 0n, costUsdcIn: u("0.06"), realizedUsdc: 0n, buys: 1, sells: 0, buysWithoutUnits: 0 };
        const r = exitPlan({
            ...world([p], { [NVDA]: 130_000n }),
            terms: baseTerms({ takeProfitBps: 1 }),
        });
        expect(r.legs).toEqual([]);
        expect(r.skipped[0]!.why).toMatch(/never recorded/);
    });

    it("will not guess at a position it has no quote for", () => {
        const r = exitPlan({
            ...world([held(NVDA, 2n)], {}),
            terms: baseTerms({ takeProfitBps: 2000, stopLossBps: 2000 }),
        });
        expect(r.legs).toEqual([]);
        expect(r.skipped[0]!.why).toMatch(/no live quote/);
    });

    it("stays quiet about a position it has already sold out of", () => {
        // zero units and zero cost is not news, and reporting it would bury the real refusals
        const empty: Position = { asset: NVDA, units: 0n, costUsdcIn: 0n, realizedUsdc: u("0.03"), buys: 1, sells: 1, buysWithoutUnits: 0 };
        const r = exitPlan({ ...world([empty], { [NVDA]: 130_000n }), terms: baseTerms({ takeProfitBps: 1 }) });
        expect(r.skipped).toEqual([]);
        expect(r.legs).toEqual([]);
    });
});

describe("an exit the owner asks for by name", () => {
    it("sells on request with no price trigger and no exit term set", () => {
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 100_000n }),
            terms: baseTerms(),
            requested: [{ asset: NVDA }],
        });
        expect(r.candidates[0]!.reason).toBe("owner_request");
        expect(r.legs[0]!.unitsIn).toBe(2n * ONE);
    });

    it("sells only the part that was asked for", () => {
        const r = exitPlan({
            ...world([held(NVDA, 4n)], { [NVDA]: 100_000n }),
            terms: baseTerms(),
            requested: [{ asset: NVDA, units: ONE }],
        });
        expect(r.legs[0]!.unitsIn).toBe(ONE);
        // a quarter of the position is worth a quarter of it, not all of it
        expect(r.legs[0]!.usdcIn).toBe(u("0.10"));
        expect(r.candidates[0]!.costUsdc).toBe(u("0.10"));
    });

    it("refuses to sell more than is held", () => {
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 100_000n }),
            terms: baseTerms(),
            requested: [{ asset: NVDA, units: 9n * ONE }],
        });
        expect(r.legs).toEqual([]);
        expect(r.skipped[0]!.why).toMatch(/ai-compute holds 2000000000000000000/);
    });

    it("says so when the owner names a token the agent does not hold", () => {
        // silence here would read as "sold", which is the worst possible answer
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 100_000n }),
            terms: baseTerms(),
            requested: [{ asset: META }],
        });
        expect(r.legs).toEqual([]);
        expect(r.skipped).toEqual([{ asset: META, symbol: "METAc", why: expect.stringContaining("nothing to sell") }]);
    });

    it("does not also evaluate a requested asset against the rules", () => {
        // one leg, not two: the owner asking is the decision
        const r = exitPlan({
            ...world([held(NVDA, 2n)], { [NVDA]: 130_000n }),
            terms: baseTerms({ takeProfitBps: 2000 }),
            requested: [{ asset: NVDA }],
        });
        expect(r.legs).toHaveLength(1);
        expect(r.candidates[0]!.reason).toBe("owner_request");
    });
});


describe("trimming a theme that has drifted", () => {
    const ONE18 = 10n ** 18n;
    /** Two themes, one token each, so a theme's weight is just what its token is worth. */
    const twoThemes = (nvdaTokens: bigint, metaTokens: bigint, prices: Record<string, bigint>) => {
        const holdings = [
            { theme: "ai-compute", asset: NVDA, units: nvdaTokens * ONE18, costUsdcIn: u("0.10") * nvdaTokens },
            { theme: "platform-giants", asset: META, units: metaTokens * ONE18, costUsdcIn: u("0.10") * metaTokens },
        ];
        return {
            holdings,
            positions: new Map(holdings.map((h) => [h.asset, {
                asset: h.asset, units: h.units, costUsdcIn: h.costUsdcIn,
                realizedUsdc: 0n, buys: 1, sells: 0, buysWithoutUnits: 0,
            }])),
            prices: new Map(Object.entries(prices)),
            decimals: new Map([[NVDA, 18], [META, 18]]),
            symbols: new Map([[NVDA, "NVDAc"], [META, "METAc"]]),
        };
    };

    it("sells the over-weight theme back to its target and leaves the other alone", () => {
        // 50/30 renormalised is 62.5/37.5. NVDA triples, so ai-compute runs to 83.3%.
        const r = exitPlan({
            ...twoThemes(5n, 3n, { [NVDA]: 300_000n, [META]: 100_000n }),
            terms: baseTerms({ rebalanceBandBps: 500 }),
        });
        expect(r.candidates).toHaveLength(1);
        const trim = r.candidates[0]!;
        expect(trim.reason).toBe("rebalance");
        expect(trim.theme).toBe("ai-compute");
        // Solved for the weight after the sale: 1.50 of 1.80 is back to 62.5% once 1.00 has gone,
        // a unit of rounding short because the trim is split across the theme's holdings.
        expect(trim.valueUsdc).toBe(u("1.00") - 1n);
        expect(r.legs[0]).toMatchObject({ side: "sell", theme: "ai-compute", symbol: "NVDAc" });
        // and it sells only part of the holding, not the whole thing
        expect(r.legs[0]!.unitsIn!).toBeLessThan(5n * ONE18);
    });

    it("proposes nothing while every theme is inside the band", () => {
        const r = exitPlan({
            ...twoThemes(5n, 3n, { [NVDA]: 105_000n, [META]: 100_000n }),
            terms: baseTerms({ rebalanceBandBps: 500 }),
        });
        expect(r.legs).toEqual([]);
        expect(r.drift.themes.every((t) => !t.overBand)).toBe(true);
    });

    it("proposes nothing when the mandate states no band, however far it has drifted", () => {
        const r = exitPlan({
            ...twoThemes(9n, 1n, { [NVDA]: 100_000n, [META]: 100_000n }),
            terms: baseTerms(),
        });
        expect(r.legs).toEqual([]);
        // the drift is still reported, so an owner can see what a band would do
        expect(r.drift.themes.find((t) => t.theme === "ai-compute")!.driftBps).toBeGreaterThan(0);
    });

    it("reports the drift even when it is trimming nothing", () => {
        const r = exitPlan({
            ...twoThemes(5n, 3n, { [NVDA]: 100_000n, [META]: 100_000n }),
            terms: baseTerms({ rebalanceBandBps: 500 }),
        });
        expect(r.drift.totalUsdc).toBe(u("0.80"));
        expect(r.drift.themes).toHaveLength(2);
    });

    it("spreads one theme's trim across its tokens, leaving the mix inside it unchanged", () => {
        // ai-compute holds two tokens; a trim is about the theme's weight, not about picking a winner.
        const holdings = [
            { theme: "ai-compute", asset: NVDA, units: 4n * ONE18, costUsdcIn: u("0.40") },
            { theme: "ai-compute", asset: MSFT, units: 4n * ONE18, costUsdcIn: u("0.40") },
            { theme: "platform-giants", asset: META, units: 2n * ONE18, costUsdcIn: u("0.20") },
        ];
        const r = exitPlan({
            holdings,
            positions: new Map(holdings.map((h) => [h.asset, {
                asset: h.asset, units: h.units, costUsdcIn: h.costUsdcIn,
                realizedUsdc: 0n, buys: 1, sells: 0, buysWithoutUnits: 0,
            }])),
            prices: new Map([[NVDA, 100_000n], [MSFT, 100_000n], [META, 100_000n]]),
            decimals: new Map([[NVDA, 18], [MSFT, 18], [META, 18]]),
            symbols: new Map([[NVDA, "NVDAc"], [MSFT, "MSFTc"], [META, "METAc"]]),
            // a smaller floor than the default, so each half of the trim clears it and the split itself
            // is what this measures
            terms: baseTerms({ rebalanceBandBps: 100, minTradeUsdc: u("0.02") }),
        });
        // ai-compute is 80% of 1.00 against a 62.5% target. Selling shrinks the portfolio too, so
        // 0.466666 has to go rather than 0.175, split evenly across its two equal holdings rather
        // than taken out of one of them.
        expect(r.candidates.map((c) => c.symbol).sort()).toEqual(["MSFTc", "NVDAc"]);
        expect(r.candidates.every((c) => c.reason === "rebalance")).toBe(true);
        const sold = r.candidates.reduce((a, c) => a + c.valueUsdc, 0n);
        expect(sold).toBe(u("0.466666"));
        expect(r.candidates[0]!.valueUsdc).toBe(r.candidates[1]!.valueUsdc);
    });

    it("lets a price rule take a whole position before the band gets a say", () => {
        // A take profit is about the position; a trim is about the weight. The position wins, and the
        // holding leaves whole rather than being half sold by one rule and half by the other.
        const r = exitPlan({
            ...twoThemes(5n, 3n, { [NVDA]: 300_000n, [META]: 100_000n }),
            terms: baseTerms({ rebalanceBandBps: 500, takeProfitBps: 10_000 }),
        });
        expect(r.candidates[0]!.reason).toBe("take_profit");
        expect(r.legs[0]!.unitsIn).toBe(5n * ONE18);
    });

    it("will not trim an amount below the mandate's smallest trade", () => {
        const r = exitPlan({
            ...twoThemes(5n, 3n, { [NVDA]: 102_000n, [META]: 100_000n }),
            terms: baseTerms({ rebalanceBandBps: 1 }),
        });
        expect(r.legs).toEqual([]);
    });
});


describe("a theme that needs trimming but cannot be trimmed", () => {
    const ONE18 = 10n ** 18n;

    it("says so rather than trimming one holding and calling the theme balanced", () => {
        // ai-compute is well over its target, but its excess split across two equal holdings leaves
        // each share under the mandate's minimum trade. Taking it all out of one would silently be a
        // view on that company, so nothing is sold and both refusals are reported.
        //
        // The floor is raised above the default so the two halves fall under it: the theme still has
        // to shed more than one trade's worth, which is what keeps it over band.
        const holdings = [
            { theme: "ai-compute", asset: NVDA, units: 4n * ONE18, costUsdcIn: u("0.40") },
            { theme: "ai-compute", asset: MSFT, units: 4n * ONE18, costUsdcIn: u("0.40") },
            { theme: "platform-giants", asset: META, units: 2n * ONE18, costUsdcIn: u("0.20") },
        ];
        const r = exitPlan({
            holdings,
            positions: new Map(holdings.map((h) => [h.asset, {
                asset: h.asset, units: h.units, costUsdcIn: h.costUsdcIn,
                realizedUsdc: 0n, buys: 1, sells: 0, buysWithoutUnits: 0,
            }])),
            prices: new Map([[NVDA, 100_000n], [MSFT, 100_000n], [META, 100_000n]]),
            decimals: new Map([[NVDA, 18], [MSFT, 18], [META, 18]]),
            symbols: new Map([[NVDA, "NVDAc"], [MSFT, "MSFTc"], [META, "METAc"]]),
            terms: baseTerms({ rebalanceBandBps: 100, minTradeUsdc: u("0.30") }),
        });
        expect(r.legs).toEqual([]);
        expect(r.drift.themes.find((t) => t.theme === "ai-compute")!.overBand).toBe(true);
        expect(r.skipped.map((x) => x.symbol).sort()).toEqual(["MSFTc", "NVDAc"]);
        for (const x of r.skipped) expect(x.why).toMatch(/below the mandate's minimum trade/);
    });
});
