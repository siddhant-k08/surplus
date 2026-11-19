import { describe, it, expect } from "vitest";
import { Treasury } from "../src/treasury";
import { MandateStore } from "../src/mandate";
import { allocate } from "../src/allocator";
import { reconcileInternal } from "../src/reconcile";
import { parseUsdc as u } from "../src/money";
import type { Leg } from "../src/policy";
import { baseTerms, NVDA, MSFT, META, AMZN } from "./fixtures";

const T0 = Date.parse("2026-11-19T12:00:00Z");

function setup() {
    let t = T0;
    const clock = { now: () => new Date(t), advance: (s: number) => { t += s * 1000; } };
    const mandates = new MandateStore();
    mandates.create(baseTerms(), clock.now());
    const tr = new Treasury({ mode: "sim", mandates, now: clock.now });
    tr.ledger.post({
        type: "OPENING_BALANCE", mode: "sim", at: clock.now(),
        lines: [{ account: "reserve", amount: u("1.50") }, { account: "equity.opening", amount: u("-1.50") }],
    });
    tr.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
    tr.accrueCost({ id: "c1", briefId: "b1", kind: "llm", amount: u("0.50") });
    tr.accrueCost({ id: "c2", briefId: "b1", kind: "search", amount: u("0.10") });
    tr.settleBrief("b1");
    return { tr, mandates, clock };
}

const quoted = new Map([[NVDA, 190_000_000n], [MSFT, 500_000_000n], [META, 600_000_000n], [AMZN, 260_000_000n]]);
const decimals = new Map([[NVDA, 18], [MSFT, 18], [META, 18], [AMZN, 18]]);

const exampleLegs = (): Leg[] =>
    allocate({
        investable: u("0.95"),
        terms: baseTerms(),
        themes: [
            {
                id: "ai-compute", candidates: [
                    { asset: NVDA, symbol: "NVDAc", weight: 60 },
                    { asset: MSFT, symbol: "MSFTc", weight: 40 },
                ]
            },
            {
                id: "platform-giants", candidates: [
                    { asset: META, symbol: "METAc", weight: 145 },
                    { asset: AMZN, symbol: "AMZNc", weight: 140 },
                ]
            },
        ],
    }).legs;

const types = (tr: Treasury) => tr.ledger.all().map((x) => x.type);

describe("treasury", () => {
    it("settles a brief like the worked example, once", () => {
        const { tr } = setup();
        expect(tr.ledger.balance("reserve")).toBe(u("2.00"));
        expect(tr.ledger.balance("surplus.investable")).toBe(u("0.95"));
        expect(tr.ledger.balance("surplus.retained")).toBe(u("0.95"));
        expect(tr.ledger.balance("cash.operating")).toBe(0n);
        const before = tr.ledger.all().length;
        tr.settleBrief("b1");
        expect(tr.ledger.all().length).toBe(before);
    });

    it("ignores a duplicate payment id", () => {
        const { tr } = setup();
        const before = tr.ledger.all().length;
        tr.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
        expect(tr.ledger.all().length).toBe(before);
        expect(tr.ledger.balance("revenue.research")).toBe(u("-3"));
    });

    it("runs the full loop: propose, approve, execute, reconcile", () => {
        const { tr, clock } = setup();
        expect(tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted })).toEqual({ ok: true });
        clock.advance(20);
        expect(tr.approve("pr1", "owner").ok).toBe(true);
        clock.advance(20);
        const r = tr.execute("pr1", { freshPrices: quoted, decimals });
        expect(r.ok).toBe(true);
        expect(tr.state("pr1")).toBe("SETTLED");
        expect(tr.ledger.balance(`positions.${NVDA}` as const)).toBe(u("0.285"));
        expect(tr.ledger.balance("surplus.investable")).toBe(u("0.19"));
        if (r.ok) {
            const nvda = r.fills.find((f) => f.symbol === "NVDAc")!;
            expect(nvda.quantity).toBe(1_500_000_000_000_000n); // 0.285 / 190 = 0.0015 tokens
        }
        expect(types(tr).slice(-6)).toEqual([
            "PROPOSAL_CREATED",
            "APPROVAL_RECORDED",
            "PURCHASE_SETTLED",
            "PURCHASE_SETTLED",
            "PURCHASE_SETTLED",
            "PURCHASE_SETTLED",
        ]);
        expect(reconcileInternal(tr.ledger)).toEqual({ ok: true, issues: [] });
    });

    it("refuses a proposal that breaks the mandate and logs why", () => {
        const { tr } = setup();
        const legs: Leg[] = [
            { asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.60"), maxSlippageBps: 100 },
        ];
        const r = tr.createProposal({ id: "bad", legs, quotedPrices: quoted });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/maxCompany/);
        expect(tr.state("bad")).toBe("DRAFT");
        const last = tr.ledger.all().at(-1)!;
        expect(last.type).toBe("REFUSAL");
        expect(last.memo).toMatch(/NVDAc 0\.600000 exceeds company cap 0\.380000/);
        expect(tr.ledger.balance("surplus.investable")).toBe(u("0.95"));
    });

    it("refuses legs that have no quote", () => {
        const { tr } = setup();
        const r = tr.createProposal({ id: "nq", legs: exampleLegs(), quotedPrices: new Map() });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/no usable quote/);
    });

    it("only approves a PROPOSED proposal and only executes an APPROVED one", () => {
        const { tr } = setup();
        tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted });
        expect(() => tr.execute("pr1", { freshPrices: quoted, decimals })).toThrow(/expected APPROVED/);
        tr.approve("pr1", "owner");
        expect(() => tr.approve("pr1", "owner")).toThrow(/expected PROPOSED/);
    });

    it("stops on price drift, then succeeds after re-proposing with fresh quotes", () => {
        const { tr, clock } = setup();
        tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted });
        tr.approve("pr1", "owner");
        clock.advance(30);
        const moved = new Map(quoted).set(NVDA, 193_420_000n);
        const r = tr.execute("pr1", { freshPrices: moved, decimals });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
            expect(r.reasons[0]).toBe("NVDAc moved 180 bps (limit 100 bps)");
        }
        expect(tr.state("pr1")).toBe("REAPPROVAL_REQUIRED");
        expect(types(tr)).not.toContain("PURCHASE_SETTLED");
        expect(tr.ledger.all().at(-1)!.type).toBe("REFUSAL");

        tr.repropose("pr1", moved);
        expect(tr.approve("pr1", "owner").ok).toBe(true);
        expect(tr.execute("pr1", { freshPrices: moved, decimals }).ok).toBe(true);
        expect(tr.state("pr1")).toBe("SETTLED");
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });

    it("expires an approval that waited too long", () => {
        const { tr, clock } = setup();
        tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted });
        tr.approve("pr1", "owner");
        clock.advance(601);
        const r = tr.execute("pr1", { freshPrices: quoted, decimals });
        expect(r).toMatchObject({ ok: false, outcome: "EXPIRED" });
        expect(tr.state("pr1")).toBe("EXPIRED");
        expect(tr.ledger.all().at(-1)!.type).toBe("REFUSAL");
    });

    it("requires reapproval when the mandate changed after approval", () => {
        const { tr, mandates, clock } = setup();
        tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted });
        tr.approve("pr1", "owner");
        mandates.create(baseTerms({ maxSlippageBps: 50 }), clock.now());
        const r = tr.execute("pr1", { freshPrices: quoted, decimals });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/mandate changed/);
    });

    it("stops when the investable surplus was already spent by another proposal", () => {
        const { tr } = setup();
        tr.createProposal({ id: "A", legs: exampleLegs(), quotedPrices: quoted });
        const small: Leg[] = [
            { asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.30"), maxSlippageBps: 100 },
        ];
        expect(tr.createProposal({ id: "B", legs: small, quotedPrices: quoted }).ok).toBe(true);
        tr.approve("A", "owner");
        tr.approve("B", "owner");
        expect(tr.execute("A", { freshPrices: quoted, decimals }).ok).toBe(true);
        const r = tr.execute("B", { freshPrices: quoted, decimals });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons).toContain("insufficient investable surplus");
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });

    it("throws on missing decimals without changing the proposal state", () => {
        const { tr } = setup();
        tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted });
        tr.approve("pr1", "owner");
        expect(() => tr.execute("pr1", { freshPrices: quoted, decimals: new Map() })).toThrow(/Missing decimals/);
        expect(tr.state("pr1")).toBe("APPROVED");
    });
});