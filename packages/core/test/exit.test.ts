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

const world = (positions: Position[], prices: Record<string, bigint>) => ({
    positions: new Map(positions.map((p) => [p.asset, p])),
    prices: new Map(Object.entries(prices)),
    decimals: new Map([[NVDA, 18], [MSFT, 18], [META, 18]]),
    symbols: new Map([[NVDA, "NVDAc"], [MSFT, "MSFTc"], [META, "METAc"]]),
    themes: new Map([[NVDA, "ai-compute"], [MSFT, "ai-compute"], [META, "platform-giants"]]),
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
        expect(r.skipped[0]!.why).toMatch(/only 2000000000000000000 are held/);
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
