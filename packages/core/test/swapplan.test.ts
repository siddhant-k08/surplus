import { describe, it, expect } from "vitest";
import { swapPlan, swapPlanTotal, describeSwapPlan } from "../src/swapplan";
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
