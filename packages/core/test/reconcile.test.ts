import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger";
import { reconcileInternal, comparePositions} from "../src/reconcile";
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
describe("comparing the books against the wallet", () => {
    const booked = [
        { asset: "0xAAA", symbol: "NVDAc", units: 1_000n },
        { asset: "0xbbb", symbol: "MSFTc", units: 500n },
    ];

    it("passes when the wallet holds what the agent says it bought", () => {
        const r = comparePositions(booked, new Map([["0xaaa", 1_000n], ["0xbbb", 500n]]));
        expect(r.ok).toBe(true);
        expect(r.positions.every((p) => p.verdict === "matches")).toBe(true);
    });

    it("fails when the books claim tokens the wallet does not hold", () => {
        // either a fill booked without happening, or tokens that left without an entry
        const r = comparePositions(booked, new Map([["0xaaa", 400n], ["0xbbb", 500n]]));
        expect(r.ok).toBe(false);
        expect(r.issues[0]).toMatch(/NVDAc.*short by 600/);
        expect(r.positions[0]!.verdict).toBe("short");
        expect(r.positions[0]!.differenceUnits).toBe(-600n);
    });

    it("treats a wallet holding more as worth reporting, not as a failure", () => {
        // the agent is not the only thing allowed to put tokens in the wallet
        const r = comparePositions(booked, new Map([["0xaaa", 1_500n], ["0xbbb", 500n]]));
        expect(r.ok).toBe(true);
        expect(r.positions[0]!.verdict).toBe("extra");
        expect(r.positions[0]!.differenceUnits).toBe(500n);
    });

    it("counts a token the wallet does not hold at all as short, not as absent", () => {
        const r = comparePositions(booked, new Map([["0xaaa", 1_000n]]));
        expect(r.ok).toBe(false);
        expect(r.positions[1]!.heldUnits).toBe(0n);
        expect(r.positions[1]!.verdict).toBe("short");
    });

    it("matches addresses whatever their case", () => {
        const r = comparePositions([{ asset: "0xAbCdEf", symbol: "AAPLc", units: 7n }], new Map([["0xabcdef", 7n]]));
        expect(r.ok).toBe(true);
    });
});
