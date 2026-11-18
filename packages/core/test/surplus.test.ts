import { describe, it, expect } from "vitest";
import { computeSurplus, bookSurplus } from "../src/surplus";
import { Ledger } from "../src/ledger";
import { parseUsdc as u } from "../src/money";

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