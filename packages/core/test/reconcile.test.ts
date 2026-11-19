import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger";
import { reconcileInternal } from "../src/reconcile";
import { parseUsdc as u } from "../src/money";

const at = new Date("2026-11-19T12:00:00Z");

describe("reconcileInternal", () => {
    it("passes an empty ledger", () => {
        expect(reconcileInternal(new Ledger())).toEqual({ ok: true, issues: [] });
    });

    it("passes a healthy ledger", () => {
        const l = new Ledger();
        l.post({
            type: "PAYMENT_RECEIVED", mode: "sim", at, lines: [
                { account: "cash.operating", amount: u("3") },
                { account: "revenue.research", amount: u("-3") },
            ]
        });
        l.post({
            type: "COST_ACCRUED", mode: "sim", at, lines: [
                { account: "expense.llm", amount: u("0.5") },
                { account: "cash.operating", amount: u("-0.5") },
            ]
        });
        expect(reconcileInternal(l).ok).toBe(true);
    });

    it("flags a negative cash balance", () => {
        const l = new Ledger();
        l.post({
            type: "COST_ACCRUED", mode: "sim", at, lines: [
                { account: "expense.llm", amount: u("0.5") },
                { account: "cash.operating", amount: u("-0.5") },
            ]
        });
        const r = reconcileInternal(l);
        expect(r.ok).toBe(false);
        expect(r.issues).toContain("negative balance on cash.operating");
    });

    it("flags a negative position", () => {
        const l = new Ledger();
        l.post({
            type: "PURCHASE_SETTLED", mode: "sim", at, lines: [
                { account: "positions.0xabc", amount: u("-1") },
                { account: "surplus.investable", amount: u("1") },
            ]
        });
        expect(reconcileInternal(l).issues).toContain("negative balance on positions.0xabc");
    });
});