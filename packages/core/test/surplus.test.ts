import { describe, it, expect } from "vitest";
import { computeSurplus, bookSurplus, investmentGap } from "../src/surplus";
import { Ledger } from "../src/ledger";
import { parseUsdc as u, mulBps } from "../src/money";

const base = {
    revenue: u("3"),
    costs: u("0.60"),
    reserveBalance: u("1.50"),
    reserveTarget: u("2.00"),
    investShareBps: 5000,
};

describe("surplus", () => {
    it("reproduces the section 3 worked example", () => {
        const r = computeSurplus(base);
        expect(r.net).toBe(u("2.40"));
        expect(r.reserveTopUp).toBe(u("0.50"));
        expect(r.surplus).toBe(u("1.90"));
        expect(r.investable).toBe(u("0.95"));
        expect(r.retained).toBe(u("0.95"));
        expect(r.shortfall).toBe(0n);
    });

    it("reports a shortfall and no surplus when costs exceed revenue", () => {
        const r = computeSurplus({ ...base, revenue: u("0.40") });
        expect(r.shortfall).toBe(u("0.20"));
        expect(r.reserveTopUp).toBe(0n);
        expect(r.surplus).toBe(0n);
        expect(r.investable).toBe(0n);
    });

    it("skips the top-up when the reserve is already full", () => {
        const r = computeSurplus({ ...base, reserveBalance: u("2.50") });
        expect(r.reserveTopUp).toBe(0n);
        expect(r.surplus).toBe(u("2.40"));
    });

    it("uses all net revenue for the reserve when it is not enough to fill the gap", () => {
        const r = computeSurplus({ ...base, reserveBalance: u("0"), revenue: u("1.60") });
        expect(r.net).toBe(u("1.00"));
        expect(r.reserveTopUp).toBe(u("1.00"));
        expect(r.surplus).toBe(0n);
    });

    it("rounds investable down and keeps the remainder as retained", () => {
        const r = computeSurplus({ ...base, revenue: u("2.600001"), costs: u("0.60"), reserveBalance: u("2"), investShareBps: 5000 });
        expect(r.surplus).toBe(2_000_001n);
        expect(r.investable).toBe(1_000_000n);
        expect(r.retained).toBe(1_000_001n);
    });

    it("rejects negative inputs and invalid bps", () => {
        expect(() => computeSurplus({ ...base, revenue: -1n })).toThrow(/negative/);
        expect(() => computeSurplus({ ...base, investShareBps: 10_001 })).toThrow();
    });

    it("books the reserve top-up and surplus split into the ledger", () => {
        const l = new Ledger();
        const at = new Date(Date.UTC(2026, 10, 18, 12));
        l.post({
            type: "OPENING_BALANCE", mode: "sim", at, lines: [
                { account: "reserve", amount: u("1.50") },
                { account: "equity.opening", amount: u("-1.50") },
            ]
        });
        l.post({
            type: "PAYMENT_RECEIVED", mode: "sim", at, lines: [
                { account: "cash.operating", amount: u("3") },
                { account: "revenue.research", amount: u("-3") },
            ]
        });
        l.post({
            type: "COST_ACCRUED", mode: "sim", at, lines: [
                { account: "expense.llm", amount: u("0.50") },
                { account: "cash.operating", amount: u("-0.50") },
            ]
        });
        l.post({
            type: "COST_ACCRUED", mode: "sim", at, lines: [
                { account: "expense.search", amount: u("0.10") },
                { account: "cash.operating", amount: u("-0.10") },
            ]
        });

        bookSurplus(l, computeSurplus(base), { mode: "sim", at, key: "brief-1" });

        expect(l.balance("cash.operating")).toBe(0n);
        expect(l.balance("reserve")).toBe(u("2.00"));
        expect(l.balance("surplus.investable")).toBe(u("0.95"));
        expect(l.balance("surplus.retained")).toBe(u("0.95"));
        let total = 0n;
        for (const v of l.balances().values()) total += v;
        expect(total).toBe(0n);
    });

    it("does not double-book when called twice with the same key", () => {
        const l = new Ledger();
        const at = new Date(Date.UTC(2026, 10, 18, 12));
        l.post({
            type: "PAYMENT_RECEIVED", mode: "sim", at, lines: [
                { account: "cash.operating", amount: u("3") },
                { account: "revenue.research", amount: u("-3") },
            ]
        });
        const r = computeSurplus({ ...base, costs: 0n, reserveBalance: u("2") });
        bookSurplus(l, r, { mode: "sim", at, key: "brief-2" });
        bookSurplus(l, r, { mode: "sim", at, key: "brief-2" });
        expect(l.balance("surplus.investable")).toBe(u("1.50"));
        expect(l.all()).toHaveLength(2);
    });
});
describe("how far the agent is from being able to invest", () => {
    const base = {
        revenue: u("0.02"),
        costs: u("0.1476"),
        reserveBalance: u("0.02"),
        reserveTarget: u("0.50"),
        investShareBps: 5000,
        minTrade: u("0.05"),
        investable: 0n,
    };

    it("adds up the costs, the reserve and the surplus the share has to come from", () => {
        const g = investmentGap(base);
        expect(g.canInvest).toBe(false);
        expect(g.shortfall).toBe(u("0.1276"));      // costs not yet covered by revenue
        expect(g.reserveGap).toBe(u("0.48"));       // the protected reserve, still short
        expect(g.surplusNeeded).toBe(u("0.10"));    // half of which is the 0.05 minimum trade
        expect(g.revenueNeeded).toBe(u("0.1276") + u("0.48") + u("0.10"));
    });

    it("says a trade is possible once investable clears the minimum", () => {
        const g = investmentGap({ ...base, investable: u("0.05") });
        expect(g).toEqual({ canInvest: true, shortfall: 0n, reserveGap: 0n, surplusNeeded: 0n, revenueNeeded: 0n });
    });

    it("counts investable money that is there but too small to place", () => {
        // 0.04 sitting investable, 0.05 needed: only the missing 0.01 has to be earned through the share
        const g = investmentGap({ ...base, revenue: u("1.00"), costs: 0n, reserveBalance: u("0.50"), investable: u("0.04") });
        expect(g.shortfall).toBe(0n);
        expect(g.reserveGap).toBe(0n);
        expect(g.surplusNeeded).toBe(u("0.02"));
        expect(g.revenueNeeded).toBe(u("0.02"));
    });

    it("rounds the surplus up, because the invest share rounds down", () => {
        // a third of the surplus, needing 1 unit: a third of 3 units is 1, a third of 2 is 0
        const g = investmentGap({
            revenue: u("1.00"), costs: 0n, reserveBalance: u("1.00"), reserveTarget: u("1.00"),
            investShareBps: 3333, minTrade: 1n, investable: 0n,
        });
        expect(g.surplusNeeded).toBe(4n);
        expect(mulBps(g.surplusNeeded, 3333)).toBeGreaterThanOrEqual(1n);
    });

    it("reports no reachable amount when the owner invests none of the surplus", () => {
        const g = investmentGap({ ...base, investShareBps: 0 });
        expect(g.canInvest).toBe(false);
        expect(g.revenueNeeded).toBe(0n); // no amount of revenue changes a zero share; the term has to
        expect(g.shortfall).toBe(u("0.1276"));
    });
});
