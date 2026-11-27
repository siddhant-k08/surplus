import { describe, it, expect } from "vitest";
import { swapPlan, swapPlanTotal, describeSwapPlan, splitFill, orderShares, type SwapOrder } from "../src/swapplan";
import { parseUsdc as u } from "../src/money";
import type { Leg } from "../src/policy";
import { NVDA, MSFT } from "./fixtures";

const leg = (asset: string, symbol: string, theme: string, amount: string, slip = 100): Leg => ({
    asset, symbol, theme, usdcIn: u(amount), maxSlippageBps: slip,
});

const CAP = u("1.00");

describe("swapPlan", () => {
    it("merges legs for the same token across themes and keeps the per-theme split", () => {
        const legs = [
            leg(NVDA, "NVDAc", "ai-compute", "0.10"),
            leg(MSFT, "MSFTc", "ai-compute", "0.20"),
            leg(NVDA, "NVDAc", "platform-giants", "0.05"),
        ];
        const plan = swapPlan(legs, CAP);
        expect(plan.length).toBe(2);
        const nvda = plan.find((o) => o.asset === NVDA)!;
        expect(nvda.usdcIn).toBe(u("0.15"));
        expect(nvda.parts).toEqual([
            { theme: "ai-compute", usdcIn: u("0.10") },
            { theme: "platform-giants", usdcIn: u("0.05") },
        ]);
        expect(swapPlanTotal(plan)).toBe(u("0.35"));
    });

    it("spends exactly what the legs spent", () => {
        const legs = [
            leg(NVDA, "NVDAc", "ai-compute", "0.123456"),
            leg(NVDA, "NVDAc", "platform-giants", "0.000001"),
            leg(MSFT, "MSFTc", "ai-compute", "0.7"),
        ];
        const total = legs.reduce((a, l) => a + l.usdcIn, 0n);
        expect(swapPlanTotal(swapPlan(legs, CAP))).toBe(total);
    });

    it("never merges past the owner's max trade, and splits when it must", () => {
        const legs = [
            leg(NVDA, "NVDAc", "ai-compute", "0.80"),
            leg(NVDA, "NVDAc", "platform-giants", "0.70"),
        ];
        const plan = swapPlan(legs, CAP);
        expect(plan.length).toBe(2);
        expect(plan.every((o) => o.usdcIn <= CAP)).toBe(true);
        expect(swapPlanTotal(plan)).toBe(u("1.50"));
        // the second theme's money is split across both orders rather than being dropped or merged over the cap
        expect(plan[0]!.parts).toEqual([
            { theme: "ai-compute", usdcIn: u("0.80") },
            { theme: "platform-giants", usdcIn: u("0.20") },
        ]);
        expect(plan[1]!.parts).toEqual([{ theme: "platform-giants", usdcIn: u("0.50") }]);
    });

    it("takes the tightest slippage of the legs it merges", () => {
        const plan = swapPlan(
            [leg(NVDA, "NVDAc", "ai-compute", "0.10", 100), leg(NVDA, "NVDAc", "platform-giants", "0.10", 30)],
            CAP,
        );
        expect(plan[0]!.maxSlippageBps).toBe(30);
    });

    it("leaves a single-theme plan alone and matches legs one to one", () => {
        const legs = [leg(NVDA, "NVDAc", "ai-compute", "0.10"), leg(MSFT, "MSFTc", "ai-compute", "0.20")];
        const plan = swapPlan(legs, CAP);
        expect(plan.length).toBe(2);
        expect(plan.map((o) => o.parts.length)).toEqual([1, 1]);
    });

    it("handles no legs, and refuses a non-positive cap", () => {
        expect(swapPlan([], CAP)).toEqual([]);
        expect(() => swapPlan([leg(NVDA, "NVDAc", "ai-compute", "0.10")], 0n)).toThrow();
    });

    it("describes each order with the themes that paid for it", () => {
        const plan = swapPlan(
            [leg(NVDA, "NVDAc", "ai-compute", "0.10"), leg(NVDA, "NVDAc", "platform-giants", "0.05")],
            CAP,
        );
        expect(describeSwapPlan(plan)[0]).toBe("NVDAc   0.150000 USDC (ai-compute 0.100000 + platform-giants 0.050000)");
    });
});

describe("splitting a real fill back across the legs that paid for it", () => {
    it("divides in proportion to what each leg put in", () => {
        expect(splitFill(1000n, [u("1.00"), u("3.00")])).toEqual([250n, 750n]);
    });

    it("accounts for every unit, giving the rounding remainder to the largest contributor", () => {
        // tokens in the wallet and in no entry would make the books disagree with the chain
        const shares = splitFill(10n, [1n, 1n, 1n]);
        expect(shares.reduce((a, s) => a + s, 0n)).toBe(10n);
        expect(shares).toEqual([4n, 3n, 3n]);
    });

    it("handles one leg taking the whole swap", () => {
        expect(splitFill(777n, [u("2.00")])).toEqual([777n]);
    });

    it("refuses nonsense rather than inventing a split", () => {
        expect(() => splitFill(-1n, [1n])).toThrow(/must not be negative/);
        expect(() => splitFill(10n, [])).toThrow(/add up to more than nothing/);
        expect(() => splitFill(10n, [0n, 0n])).toThrow(/add up to more than nothing/);
        expect(() => splitFill(10n, [1n, -1n])).toThrow(/must not be negative/);
    });
});

/** What each leg received across every swap that executed, keyed by position in the plan. */
const attributeFills = (legs: Leg[], plan: SwapOrder[], filled: Map<number, bigint>) => {
    const out = new Map<number, bigint>();
    for (const [position, amount] of filled) {
        for (const s of orderShares(legs, plan, position, amount)) {
            out.set(s.leg, (out.get(s.leg) ?? 0n) + s.quantity);
        }
    }
    return out;
};

describe("attributing real fills back to legs", () => {
    const leg = (theme: string, asset: string, usdc: string): Leg => ({
        symbol: asset === NVDA ? "NVDAc" : "MSFTc", asset, theme, usdcIn: u(usdc), maxSlippageBps: 100,
    });

    it("splits one swap across the themes that funded it", () => {
        const legs = [leg("ai-compute", NVDA, "0.75"), leg("platform-giants", NVDA, "0.25")];
        const plan = swapPlan(legs, u("5.00"));
        expect(plan.length).toBe(1);

        const out = attributeFills(legs, plan, new Map([[0, 400n]]));
        expect(out.get(0)).toBe(300n);
        expect(out.get(1)).toBe(100n);
    });

    it("adds up a leg that the trade cap spread over several swaps", () => {
        // one leg bigger than the cap becomes two swaps, and the quantities belong to the same leg
        const legs = [leg("ai-compute", NVDA, "3.00")];
        const plan = swapPlan(legs, u("2.00"));
        expect(plan.length).toBe(2);

        const out = attributeFills(legs, plan, new Map([[0, 200n], [1, 100n]]));
        expect(out.get(0)).toBe(300n);
    });

    it("leaves out the legs of a swap that did not execute", () => {
        const legs = [leg("ai-compute", NVDA, "1.00"), leg("platform-giants", MSFT, "1.00")];
        const plan = swapPlan(legs, u("5.00"));
        const nvdaFirst = plan.findIndex((o) => o.asset.toLowerCase() === NVDA.toLowerCase());

        const out = attributeFills(legs, plan, new Map([[nvdaFirst, 500n]]));
        expect(out.get(0)).toBe(500n);
        expect(out.has(1)).toBe(false); // the swap that never happened credits nothing
    });

    it("says how much of each leg one swap covered, whatever became of the others", () => {
        const legs = [leg("ai-compute", NVDA, "1.50"), leg("platform-giants", NVDA, "1.50")];
        const plan = swapPlan(legs, u("2.00"));
        expect(orderShares(legs, plan, 1, 100n))
            .toEqual([{ leg: 1, quantity: 100n, usdcIn: u("1.00") }]);
    });

    it("attributes a sale to the sale legs, not to a buy of the same token", () => {
        const legs: Leg[] = [
            leg("ai-compute", NVDA, "1.00"),
            { ...leg("platform-giants", NVDA, "1.00"), side: "sell", unitsIn: 50n },
        ];
        const plan = swapPlan(legs, u("5.00"));
        const sale = plan.findIndex((o) => o.side === "sell");
        expect(orderShares(legs, plan, sale, 900n))
            .toEqual([{ leg: 1, quantity: 900n, usdcIn: u("1.00"), unitsIn: 50n }]);
    });

    it("keeps every unit when a cap splits a swap that several themes share", () => {
        const legs = [leg("ai-compute", NVDA, "1.50"), leg("platform-giants", NVDA, "1.50")];
        const plan = swapPlan(legs, u("2.00"));
        const out = attributeFills(legs, plan, new Map(plan.map((_, i) => [i, 1000n])));
        const total = [...out.values()].reduce((a, v) => a + v, 0n);
        expect(total).toBe(BigInt(plan.length) * 1000n);
    });
});


describe("planning a sale", () => {
    const ONE = 10n ** 18n;
    const leg = (over: Partial<Leg> = {}): Leg => ({
        asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.30"), maxSlippageBps: 100, ...over,
    });

    it("merges two sales of one token into a single swap, units and all", () => {
        const orders = swapPlan(
            [
                leg({ side: "sell", unitsIn: ONE }),
                leg({ side: "sell", unitsIn: 2n * ONE, theme: "platform-giants" }),
            ],
            u("1.00"),
        );
        expect(orders).toHaveLength(1);
        expect(orders[0]!.side).toBe("sell");
        expect(orders[0]!.unitsIn).toBe(3n * ONE);
        expect(orders[0]!.usdcIn).toBe(u("0.60"));
        expect(orders[0]!.parts.map((p) => p.theme)).toEqual(["ai-compute", "platform-giants"]);
    });

    it("never merges a buy and a sale of the same token into one swap", () => {
        // netting them would produce one swap that does neither, and would lose the units to dispose of
        const orders = swapPlan([leg(), leg({ side: "sell", unitsIn: ONE })], u("1.00"));
        expect(orders).toHaveLength(2);
        expect(orders.filter((o) => o.side === "sell")).toHaveLength(1);
        expect(orders.find((o) => o.side === undefined)!.unitsIn).toBeUndefined();
    });

    it("splits a sale at the trade cap and disposes of exactly the units asked for", () => {
        const orders = swapPlan([leg({ side: "sell", usdcIn: u("1.00"), unitsIn: 3n * ONE })], u("0.40"));
        expect(orders).toHaveLength(3);
        expect(orders.reduce((a, o) => a + o.usdcIn, 0n)).toBe(u("1.00"));
        // not a unit more or less than the leg asked to sell
        expect(orders.reduce((a, o) => a + (o.unitsIn ?? 0n), 0n)).toBe(3n * ONE);
        for (const o of orders) expect(o.usdcIn).toBeLessThanOrEqual(u("0.40"));
    });

    it("leaves a buy-only plan exactly as it was", () => {
        const orders = swapPlan([leg(), leg({ theme: "platform-giants" })], u("1.00"));
        expect(orders).toHaveLength(1);
        expect(orders[0]!.side).toBeUndefined();
        expect(orders[0]!.unitsIn).toBeUndefined();
    });
});
