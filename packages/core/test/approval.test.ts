import { describe, it, expect } from "vitest";
import { ProposalMachine, precheck, proposalHash, driftBps, type Approval } from "../src/approval";
import { MandateStore } from "../src/mandate";
import type { Proposal, Leg } from "../src/policy";
import { parseUsdc as u } from "../src/money";
import { baseTerms, NVDA, META } from "./fixtures";

const t0 = new Date("2026-11-18T12:00:00Z");
const plus = (s: number) => new Date(t0.getTime() + s * 1000);

const leg = (asset: string, symbol: string, theme: string, amt: string): Leg => ({
    asset, symbol, theme, usdcIn: u(amt), maxSlippageBps: 100,
});
const proposal: Proposal = {
    investable: u("0.95"),
    legs: [leg(NVDA, "NVDAc", "ai-compute", "0.285"), leg(META, "METAc", "platform-giants", "0.145")],
};

const store = new MandateStore();
const m1 = store.create(baseTerms(), t0);

const approval = (over: Partial<Approval> = {}): Approval => ({
    proposalHash: proposalHash(proposal, m1.hash),
    mandateVersion: m1.version,
    mandateHash: m1.hash,
    maxUsdcIn: u("0.43"),
    expiresAt: plus(600).toISOString(),
    ...over,
});

const quoted = new Map([[NVDA, 190_000_000n], [META, 600_000_000n]]);
const input = (over: Partial<Parameters<typeof precheck>[0]> = {}) => ({
    approval: approval(),
    proposal,
    mandate: { version: m1.version, hash: m1.hash, terms: m1.terms },
    now: plus(30),
    quotedPrices: quoted,
    freshPrices: quoted,
    ...over,
});

describe("proposal state machine", () => {
    it("walks the happy path and records history", () => {
        const m = new ProposalMachine();
        for (const s of ["PROPOSED", "APPROVED", "PRECHECK", "EXECUTING", "SETTLED"] as const) {
            m.transition(s, t0);
        }
        expect(m.state).toBe("SETTLED");
        expect(m.history().map((h) => h.to)).toEqual(["PROPOSED", "APPROVED", "PRECHECK", "EXECUTING", "SETTLED"]);
    });

    it("rejects illegal transitions and leaves terminal states terminal", () => {
        const m = new ProposalMachine();
        expect(() => m.transition("EXECUTING", t0)).toThrow(/Illegal/);
        for (const s of ["PROPOSED", "APPROVED", "PRECHECK", "EXECUTING", "SETTLED"] as const) m.transition(s, t0);
        expect(() => m.transition("PROPOSED", t0)).toThrow(/Illegal/);
    });

    it("lets a refused proposal go back to DRAFT for editing", () => {
        const m = new ProposalMachine();
        m.transition("PROPOSED", t0);
        m.transition("DRAFT", t0, "policy refusal: maxCompany");
        expect(m.state).toBe("DRAFT");
        expect(m.history()[1]!.reason).toMatch(/maxCompany/);
    });

    it("sends a failed precheck to REAPPROVAL_REQUIRED, then back to PROPOSED", () => {
        const m = new ProposalMachine();
        for (const s of ["PROPOSED", "APPROVED", "PRECHECK", "REAPPROVAL_REQUIRED", "PROPOSED"] as const) {
            m.transition(s, t0);
        }
        expect(m.state).toBe("PROPOSED");
    });
});

describe("precheck", () => {
    it("proceeds when nothing has changed", () => {
        expect(precheck(input())).toEqual({ outcome: "PROCEED", reasons: [] });
    });

    it("reports EXPIRED after the approval window", () => {
        expect(precheck(input({ now: plus(601) })).outcome).toBe("EXPIRED");
    });

    it("requires reapproval when the proposal was changed", () => {
        const changed: Proposal = { ...proposal, legs: [leg(NVDA, "NVDAc", "ai-compute", "0.30"), proposal.legs[1]!] };
        const r = precheck(input({ proposal: changed }));
        expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
        expect(r.reasons.join(" ")).toMatch(/differs/);
    });

    it("requires reapproval when the mandate version changed", () => {
        const m2 = store.create(baseTerms({ maxSlippageBps: 50 }), t0);
        const r = precheck(input({ mandate: { version: m2.version, hash: m2.hash, terms: m2.terms } }));
        expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
        expect(r.reasons.join(" ")).toMatch(/mandate changed/);
    });

    it("requires reapproval when price drift exceeds the tolerance", () => {
        const fresh = new Map([[NVDA, 193_420_000n], [META, 600_000_000n]]);
        const r = precheck(input({ freshPrices: fresh }));
        expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
        expect(r.reasons[0]).toBe("NVDAc moved 180 bps (limit 100 bps)");
    });

    it("allows drift within the tolerance", () => {
        const fresh = new Map([[NVDA, 191_000_000n], [META, 600_000_000n]]);
        expect(precheck(input({ freshPrices: fresh })).outcome).toBe("PROCEED");
    });

    it("requires reapproval when a fresh quote is missing", () => {
        const r = precheck(input({ freshPrices: new Map([[NVDA, 190_000_000n]]) }));
        expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
        expect(r.reasons).toContain("no usable fresh quote for METAc");
    });

    it("requires reapproval when the total exceeds the approved maximum", () => {
        const r = precheck(input({ approval: approval({ maxUsdcIn: u("0.40") }) }));
        expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
        expect(r.reasons.join(" ")).toMatch(/exceeds approved maximum/);
    });

    it("re-runs the policy checks against the current terms", () => {
        const tighter = baseTerms({ maxTradeUsdc: u("0.20") });
        const r = precheck(input({ mandate: { version: m1.version, hash: m1.hash, terms: tighter } }));
        expect(r.outcome).toBe("REAPPROVAL_REQUIRED");
        expect(r.reasons.join(" ")).toMatch(/policy maxTrade/);
    });
});

describe("hashing and drift helpers", () => {
    it("proposalHash is deterministic and sensitive to the mandate hash", () => {
        expect(proposalHash(proposal, m1.hash)).toBe(proposalHash(proposal, m1.hash));
        expect(proposalHash(proposal, m1.hash)).not.toBe(proposalHash(proposal, "other"));
    });

    it("driftBps rounds down and is symmetric in direction", () => {
        expect(driftBps(190_000_000n, 193_420_000n)).toBe(180n);
        expect(driftBps(190_000_000n, 186_580_000n)).toBe(180n);
        expect(() => driftBps(0n, 1n)).toThrow();
    });
});