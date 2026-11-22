import { describe, it, expect } from "vitest";
import { Treasury } from "../src/treasury";
import { Ledger } from "../src/ledger";
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

    it("stops when pre-trade gates report a block, and books nothing", () => {
        const { tr } = setup();
        tr.createProposal({ id: "pr1", legs: exampleLegs(), quotedPrices: quoted });
        tr.approve("pr1", "owner");
        const r = tr.execute("pr1", { freshPrices: quoted, decimals, blocks: ["NVDAc quote: quote is 40s old (limit 25s)"] });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
            expect(r.reasons).toEqual(["NVDAc quote: quote is 40s old (limit 25s)"]);
        }
        expect(types(tr)).not.toContain("PURCHASE_SETTLED");
        expect(tr.ledger.all().at(-1)!.type).toBe("REFUSAL");
    });

    it("fills both legs when one asset appears in two themes, and aggregates the position", () => {
        const { tr } = setup();
        // real research puts the same company in more than one theme; each leg must still book its own fill
        const legs = allocate({
            investable: u("0.95"),
            terms: baseTerms(),
            themes: [
                {
                    id: "ai-compute", candidates: [
                        { asset: NVDA, symbol: "NVDAc", weight: 40 },
                        { asset: MSFT, symbol: "MSFTc", weight: 60 },
                    ]
                },
                {
                    id: "platform-giants", candidates: [
                        { asset: NVDA, symbol: "NVDAc", weight: 50 },
                        { asset: META, symbol: "METAc", weight: 50 },
                    ]
                },
            ],
        }).legs;
        expect(legs.filter((l) => l.asset === NVDA).length).toBe(2);

        tr.createProposal({ id: "dup", legs, quotedPrices: quoted });
        tr.approve("dup", "owner");
        const r = tr.execute("dup", { freshPrices: quoted, decimals });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.fills.length).toBe(legs.length);
        expect(types(tr).filter((t) => t === "PURCHASE_SETTLED").length).toBe(legs.length);
        const onNvda = legs.filter((l) => l.asset === NVDA).reduce((a, l) => a + l.usdcIn, 0n);
        expect(tr.ledger.balance(`positions.${NVDA}`)).toBe(onNvda);
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });
});
describe("restoring a treasury from its ledger", () => {
    // what a process restart looks like: same mandate, same mode, ledger replayed from disk
    const restart = (tr: Treasury, mandates: MandateStore) =>
        new Treasury({ mode: "sim", mandates, ledger: Ledger.replay(tr.ledger.all()) });

    it("rebuilds per-brief revenue and costs, so settleBrief is not computed from zero", () => {
        const { tr, mandates } = setup(); // books b1: 3.00 revenue, 0.60 costs, then settles
        const before = tr.settleBrief("b1");

        const again = restart(tr, mandates);
        const after = again.settleBrief("b1");
        expect(after).toEqual(before);
        expect(again.ledger.all().length).toBe(tr.ledger.all().length); // nothing re-booked
    });

    it("does not sweep a brief's money twice after a restart", () => {
        const { tr, mandates } = setup(); // setup already swept b1
        expect(tr.ledger.balance("reserve")).toBeGreaterThan(0n);
        expect(tr.ledger.balance("surplus.investable")).toBeGreaterThan(0n);
        const balancesBefore = [...tr.ledger.balances()];

        // the hazard: after a restart the brief's lifetime totals are back, so a naive re-sweep would
        // move the same money again, now against a reserve that is already at target
        const again = restart(tr, mandates);
        const n = again.ledger.all().length;
        const resweep = again.settleBrief("b1");
        expect(resweep.reserveTopUp).toBe(0n);
        expect(resweep.surplus).toBe(0n);
        expect(again.ledger.all().length).toBe(n);
        expect([...again.ledger.balances()]).toEqual(balancesBefore);
    });

    it("restores the seen-payment and seen-cost ids", () => {
        const { tr, mandates } = setup();
        const again = restart(tr, mandates);
        const n = again.ledger.all().length;
        again.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
        again.accrueCost({ id: "c1", briefId: "b1", kind: "llm", amount: u("0.50") });
        expect(again.ledger.all().length).toBe(n);
        expect(again.settleBrief("b1")).toEqual(tr.settleBrief("b1"));
    });

    it("keeps revenue attributed to the right brief", () => {
        const { tr, mandates } = setup();
        tr.receivePayment({ id: "p2", briefId: "b2", amount: u("1.00") });
        tr.accrueCost({ id: "c3", briefId: "b2", kind: "llm", amount: u("0.10") });
        // b2 has not been swept yet, so a restored treasury must still sweep its 0.90
        const again = restart(tr, mandates);
        const b2 = again.settleBrief("b2");
        expect(b2.net).toBe(u("0.90"));
        expect(b2.reserveTopUp + b2.surplus).toBe(u("0.90"));
        // b1 was already swept before the restart, so there is nothing left of it to sweep
        expect(again.settleBrief("b1").net).toBe(0n);
    });

    it("tolerates entries written before briefId existed, without attributing them", () => {
        // the field was added later; an older ledger file must load rather than crash, and its money
        // stays out of the per-brief tallies because nothing records which brief it belonged to
        const mandates = new MandateStore();
        mandates.create(baseTerms());
        const old = new Ledger();
        old.post({
            type: "PAYMENT_RECEIVED", mode: "testnet", at: new Date(T0), idempotencyKey: "pay:x402:0xold",
            txHash: "0xold", memo: "brief-old",
            lines: [
                { account: "cash.operating", amount: u("0.01") },
                { account: "revenue.research", amount: u("-0.01") },
            ],
        });
        const tr = new Treasury({ mode: "testnet", mandates, ledger: old });
        expect(tr.ledger.balance("cash.operating")).toBe(u("0.01"));
        expect(tr.settleBrief("brief-old").net).toBe(0n);
        // the payment id is still restored, so it cannot be booked a second time
        tr.receivePayment({ id: "x402:0xold", briefId: "brief-old", amount: u("0.01") });
        expect(tr.ledger.all().length).toBe(1);
    });

    it("sweeps revenue that arrives after a brief was already settled", () => {
        // the bug this replaces: settleBrief cached its first result and returned it forever, so every
        // later sale of the same brief stayed in operating cash and never became investable
        const { tr } = setup();
        const afterFirst = tr.ledger.balance("surplus.investable");
        expect(afterFirst).toBeGreaterThan(0n);

        tr.receivePayment({ id: "p9", briefId: "b1", amount: u("5.00") });
        const second = tr.settleBrief("b1");
        expect(second.net).toBe(u("5.00"));
        expect(second.surplus).toBe(u("5.00")); // the reserve is already full, so it is all surplus
        expect(tr.ledger.balance("surplus.investable")).toBe(afterFirst + u("2.50"));
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });

    it("makes good a brief's deficit before sweeping anything", () => {
        const mandates = new MandateStore();
        mandates.create(baseTerms({ reserveTargetUsdc: u("0") }));
        const tr = new Treasury({ mode: "sim", mandates });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "sim",
            lines: [{ account: "cash.operating", amount: u("5") }, { account: "equity.opening", amount: u("-5") }],
        });

        // a brief that cost more than it earned sweeps nothing and carries the loss
        tr.receivePayment({ id: "p1", briefId: "bx", amount: u("0.10") });
        tr.accrueCost({ id: "c1", briefId: "bx", kind: "llm", amount: u("0.40") });
        const first = tr.settleBrief("bx");
        expect(first.surplus).toBe(0n);
        expect(first.shortfall).toBe(u("0.30"));
        expect(tr.ledger.balance("surplus.investable")).toBe(0n);

        // later revenue covers the 0.30 deficit first; only the remaining 0.70 is swept
        tr.receivePayment({ id: "p2", briefId: "bx", amount: u("1.00") });
        const second = tr.settleBrief("bx");
        expect(second.surplus).toBe(u("0.70"));
        expect(second.investable).toBe(u("0.35"));
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });

    it("carries a deficit across a restart", () => {
        const mandates = new MandateStore();
        mandates.create(baseTerms({ reserveTargetUsdc: u("0") }));
        const tr = new Treasury({ mode: "sim", mandates });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "sim",
            lines: [{ account: "cash.operating", amount: u("5") }, { account: "equity.opening", amount: u("-5") }],
        });
        tr.receivePayment({ id: "p1", briefId: "bx", amount: u("0.10") });
        tr.accrueCost({ id: "c1", briefId: "bx", kind: "llm", amount: u("0.40") });
        tr.settleBrief("bx");

        const again = new Treasury({ mode: "sim", mandates, ledger: Ledger.replay(tr.ledger.all()) });
        again.receivePayment({ id: "p2", briefId: "bx", amount: u("1.00") });
        const swept = again.settleBrief("bx");
        expect(swept.surplus).toBe(u("0.70")); // the 0.30 deficit survived the restart
    });

    it("starts empty when handed a fresh ledger", () => {
        const mandates = new MandateStore();
        mandates.create(baseTerms());
        const tr = new Treasury({ mode: "sim", mandates, ledger: new Ledger() });
        expect(tr.settleBrief("nothing").net).toBe(0n);
    });
});

describe("booking what the chain actually returned", () => {
    const setup = () => {
        const mandates = new MandateStore();
        mandates.create(baseTerms());
        const tr = new Treasury({ mode: "mainnet", mandates });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "mainnet", at: new Date("2026-11-22T00:00:00Z"),
            memo: "investable for the test",
            lines: [
                { account: "surplus.investable", amount: u("10.00") },
                { account: "equity.opening", amount: u("-10.00") },
            ],
        });
        return { tr, mandates };
    };

    const approveTwoLegs = (tr: Treasury) => {
        const legs: Leg[] = [
            { symbol: "NVDAc", asset: NVDA, theme: "ai-compute", usdcIn: u("1.00"), maxSlippageBps: 100 },
            { symbol: "MSFTc", asset: MSFT, theme: "platform-giants", usdcIn: u("1.00"), maxSlippageBps: 100 },
        ];
        const quoted = new Map([[NVDA.toLowerCase(), u("100")], [MSFT.toLowerCase(), u("50")]]);
        expect(tr.createProposal({ id: "p1", legs, quotedPrices: quoted })).toEqual({ ok: true });
        expect(tr.approve("p1", "owner").ok).toBe(true);
        return { quoted, decimals: new Map([[NVDA.toLowerCase(), 18], [MSFT.toLowerCase(), 18]]) };
    };

    it("records the quantity the swap returned, not the one the quote predicted", () => {
        const { tr } = setup();
        const { quoted, decimals } = approveTwoLegs(tr);
        const tx = "0x" + "ab".repeat(32);

        const result = tr.execute("p1", {
            freshPrices: quoted,
            decimals,
            realized: new Map([
                [0, { quantity: 9_000_000_000_000_000n, transaction: tx }],
                [1, { quantity: 19_000_000_000_000_000n, transaction: tx }],
            ]),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.fills[0]!.quantity).toBe(9_000_000_000_000_000n); // what came back, not 10^16
        expect(result.unfilled).toEqual([]);
        expect(tr.state("p1")).toBe("SETTLED");

        const entry = tr.ledger.all().find((e) => e.type === "PURCHASE_SETTLED");
        expect(entry?.txHash).toBe(tx);
        expect(entry?.memo).not.toContain("SIMULATED");
    });

    it("books only the legs that executed, and refuses to call that settled", () => {
        // the money that moved has to appear; the money that did not must not, and a proposal that
        // half happened is not a settled proposal
        const { tr } = setup();
        const { quoted, decimals } = approveTwoLegs(tr);

        const result = tr.execute("p1", {
            freshPrices: quoted,
            decimals,
            realized: new Map([[0, { quantity: 9_000_000_000_000_000n, transaction: "0x" + "cd".repeat(32) }]]),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.fills.length).toBe(1);
        expect(result.unfilled).toEqual([{ symbol: "MSFTc", usdcIn: u("1.00"), reason: "the swap did not execute" }]);
        expect(tr.state("p1")).toBe("FAILED");

        // only the leg that happened moved money out of the investable balance
        expect(tr.ledger.balance("surplus.investable")).toBe(u("9.00"));
        expect(tr.ledger.all().filter((e) => e.type === "PURCHASE_SETTLED").length).toBe(1);
    });

    it("still simulates when no realized fills are given, and says so in the entry", () => {
        const { tr } = setup();
        const { quoted, decimals } = approveTwoLegs(tr);
        const result = tr.execute("p1", { freshPrices: quoted, decimals });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.fills.length).toBe(2);
        expect(tr.state("p1")).toBe("SETTLED");
    });
});
