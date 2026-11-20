import { Ledger, type AccountId, type EntryType, type Mode } from "./ledger";
import type { MandateStore } from "./mandate";
import { formatUsdc } from "./money";
import { bookSurplus, computeSurplus, type SurplusResult } from "./surplus";
import { checkProposal, failures, type Leg, type Proposal } from "./policy";
import {
    ProposalMachine,
    precheck,
    proposalHash,
    type Approval,
    type PrecheckOutcome,
    type PriceMap,
} from "./approval";

export type CostKind = "llm" | "search" | "gas";

const COST_ACCOUNT: Record<CostKind, AccountId> = {
    llm: "expense.llm",
    search: "expense.search",
    gas: "expense.gas",
};

export interface Fill {
    asset: string;
    symbol: string;
    usdcIn: bigint;
    price: bigint; // USDC minor units per one whole token
    quantity: bigint; // token minor units
}

export interface ProposalRecord {
    readonly id: string;
    readonly proposal: Proposal;
    quotedPrices: PriceMap;
    readonly machine: ProposalMachine;
    approval?: Approval;
    fills?: Fill[];
}

export type ProposeResult = { ok: true } | { ok: false; reasons: string[] };
export type ApproveResult = { ok: true; approval: Approval } | { ok: false; reasons: string[] };
export type ExecuteResult =
    | { ok: true; fills: Fill[] }
    | { ok: false; outcome: PrecheckOutcome; reasons: string[] };

interface BriefAccount {
    revenue: bigint;
    costs: bigint;
    result?: SurplusResult;
}

const sumLegs = (legs: readonly Leg[]): bigint => legs.reduce((a, l) => a + l.usdcIn, 0n);

export class Treasury {
    readonly ledger: Ledger;
    private readonly briefs = new Map<string, BriefAccount>();
    private readonly seenPayments = new Set<string>();
    private readonly seenCosts = new Set<string>();
    private readonly records = new Map<string, ProposalRecord>();
    private readonly now: () => Date;

    constructor(
        private readonly opts: { mode: Mode; mandates: MandateStore; now?: () => Date; ledger?: Ledger },
    ) {
        this.ledger = opts.ledger ?? new Ledger();
        this.now = opts.now ?? (() => new Date());
    }

    private brief(id: string): BriefAccount {
        let b = this.briefs.get(id);
        if (!b) {
            b = { revenue: 0n, costs: 0n };
            this.briefs.set(id, b);
        }
        return b;
    }

    private event(type: EntryType, memo: string): void {
        this.ledger.post({ type, mode: this.opts.mode, at: this.now(), lines: [], memo });
    }

    private get(id: string): ProposalRecord {
        const r = this.records.get(id);
        if (!r) throw new Error(`Unknown proposal ${id}`);
        return r;
    }
    receivePayment(i: { id: string; briefId: string; amount: bigint; txHash?: string }): void {
        if (i.amount <= 0n) throw new Error("payment amount must be positive");
        if (this.seenPayments.has(i.id)) return;
        this.ledger.post({
            type: "PAYMENT_RECEIVED",
            mode: this.opts.mode,
            at: this.now(),
            idempotencyKey: `pay:${i.id}`,
            ...(i.txHash !== undefined && { txHash: i.txHash }),
            lines: [
                { account: "cash.operating", amount: i.amount },
                { account: "revenue.research", amount: -i.amount },
            ],
        });
        this.seenPayments.add(i.id);
        this.brief(i.briefId).revenue += i.amount;
    }

    accrueCost(i: { id: string; briefId: string; kind: CostKind; amount: bigint; memo?: string }): void {
        if (i.amount <= 0n) throw new Error("cost amount must be positive");
        if (this.seenCosts.has(i.id)) return;
        this.ledger.post({
            type: "COST_ACCRUED",
            mode: this.opts.mode,
            at: this.now(),
            idempotencyKey: `cost:${i.id}`,
            ...(i.memo !== undefined && { memo: i.memo }),
            lines: [
                { account: COST_ACCOUNT[i.kind], amount: i.amount },
                { account: "cash.operating", amount: -i.amount },
            ],
        });
        this.seenCosts.add(i.id);
        this.brief(i.briefId).costs += i.amount;
    }

    /** Reserve first, then surplus. Safe to call twice for the same brief. */
    settleBrief(briefId: string): SurplusResult {
        const b = this.brief(briefId);
        if (b.result) return b.result;
        const terms = this.opts.mandates.current().terms;
        const result = computeSurplus({
            revenue: b.revenue,
            costs: b.costs,
            reserveBalance: this.ledger.balance("reserve"),
            reserveTarget: terms.reserveTargetUsdc,
            investShareBps: terms.investShareBps,
        });
        bookSurplus(this.ledger, result, { mode: this.opts.mode, at: this.now(), key: `brief-${briefId}` });
        b.result = result;
        return result;
    }

    createProposal(i: { id: string; legs: readonly Leg[]; quotedPrices: PriceMap }): ProposeResult {
        if (i.legs.length === 0) throw new Error("a proposal needs at least one leg");
        if (this.records.has(i.id)) throw new Error(`Proposal ${i.id} already exists`);

        const mandate = this.opts.mandates.current();
        const proposal: Proposal = {
            investable: this.ledger.balance("surplus.investable"),
            legs: i.legs,
        };
        const rec: ProposalRecord = {
            id: i.id,
            proposal,
            quotedPrices: i.quotedPrices,
            machine: new ProposalMachine(),
        };
        this.records.set(i.id, rec);

        const reasons = failures(checkProposal(proposal, mandate.terms)).map((f) => `${f.rule}: ${f.detail}`);
        for (const leg of i.legs) {
            const q = i.quotedPrices.get(leg.asset.toLowerCase());
            if (q === undefined || q <= 0n) reasons.push(`quote: no usable quote for ${leg.symbol}`);
        }
        if (reasons.length > 0) {
            this.event("REFUSAL", `proposal ${i.id} refused: ${reasons.join("; ")}`);
            return { ok: false, reasons };
        }

        rec.machine.transition("PROPOSED", this.now());
        this.event(
            "PROPOSAL_CREATED",
            `proposal ${i.id}: ${i.legs.length} legs, total ${formatUsdc(sumLegs(i.legs))} USDC, ` +
            `hash ${proposalHash(proposal, mandate.hash).slice(0, 12)}`,
        );
        return { ok: true };
    }

    /** The Owner's wallet signature is added in the wallet milestone; until then `by` is just a label. */
    approve(id: string, by: string): ApproveResult {
        const rec = this.get(id);
        if (rec.machine.state !== "PROPOSED") {
            throw new Error(`Proposal ${id} is ${rec.machine.state}, expected PROPOSED`);
        }
        const mandate = this.opts.mandates.current();
        const reasons = failures(checkProposal(rec.proposal, mandate.terms)).map((f) => `${f.rule}: ${f.detail}`);
        if (reasons.length > 0) {
            rec.machine.transition("DRAFT", this.now(), "policy refusal at approval");
            this.event("REFUSAL", `proposal ${id} refused at approval: ${reasons.join("; ")}`);
            return { ok: false, reasons };
        }

        const expiresAt = new Date(this.now().getTime() + mandate.terms.approvalExpirySeconds * 1000).toISOString();
        const approval: Approval = {
            proposalHash: proposalHash(rec.proposal, mandate.hash),
            mandateVersion: mandate.version,
            mandateHash: mandate.hash,
            maxUsdcIn: sumLegs(rec.proposal.legs),
            expiresAt,
        };
        rec.approval = approval;
        rec.machine.transition("APPROVED", this.now());
        this.event("APPROVAL_RECORDED", `proposal ${id} approved by ${by}, expires ${expiresAt}`);
        return { ok: true, approval };
    }

    /** Simulated execution: re-checks everything, then books fills at the fresh prices. */
    execute(
        id: string,
        i: { freshPrices: PriceMap; decimals: ReadonlyMap<string, number>; blocks?: readonly string[] },
    ): ExecuteResult {
        const rec = this.get(id);
        if (rec.machine.state !== "APPROVED" || !rec.approval) {
            throw new Error(`Proposal ${id} is ${rec.machine.state}, expected APPROVED`);
        }
        for (const leg of rec.proposal.legs) {
            if (!i.decimals.has(leg.asset.toLowerCase())) {
                throw new Error(`Missing decimals for ${leg.symbol}`);
            }
        }

        const mandate = this.opts.mandates.current();
        rec.machine.transition("PRECHECK", this.now());
        const pre = precheck({
            approval: rec.approval,
            proposal: rec.proposal,
            mandate: { version: mandate.version, hash: mandate.hash, terms: mandate.terms },
            now: this.now(),
            quotedPrices: rec.quotedPrices,
            freshPrices: i.freshPrices,
        });

        if (pre.outcome === "EXPIRED") {
            rec.machine.transition("EXPIRED", this.now(), pre.reasons.join("; "));
            this.event("REFUSAL", `proposal ${id} not executed: ${pre.reasons.join("; ")}`);
            return { ok: false, outcome: "EXPIRED", reasons: pre.reasons };
        }

        const total = sumLegs(rec.proposal.legs);
        const reasons = [...pre.reasons, ...(i.blocks ?? [])];
        if (reasons.length === 0 && this.ledger.balance("surplus.investable") < total) {
            reasons.push("insufficient investable surplus");
        }
        if (reasons.length > 0) {
            rec.machine.transition("REAPPROVAL_REQUIRED", this.now(), reasons.join("; "));
            this.event("REFUSAL", `proposal ${id} stopped before execution: ${reasons.join("; ")}`);
            return { ok: false, outcome: "REAPPROVAL_REQUIRED", reasons };
        }

        rec.machine.transition("EXECUTING", this.now());
        const fills: Fill[] = [];
        try {
            for (const leg of rec.proposal.legs) {
                const key = leg.asset.toLowerCase();
                const price = i.freshPrices.get(key)!;
                const quantity = (leg.usdcIn * 10n ** BigInt(i.decimals.get(key)!)) / price;
                const tag = this.opts.mode === "sim" ? "SIMULATED " : "";
                this.ledger.post({
                    type: "PURCHASE_SETTLED",
                    mode: this.opts.mode,
                    at: this.now(),
                    idempotencyKey: `fill:${id}:${key}`,
                    memo: `${tag}fill ${leg.symbol}: ${formatUsdc(leg.usdcIn)} USDC at ${price} => ${quantity} units`,
                    lines: [
                        { account: `positions.${key}`, amount: leg.usdcIn },
                        { account: "surplus.investable", amount: -leg.usdcIn },
                    ],
                });
                fills.push({ asset: key, symbol: leg.symbol, usdcIn: leg.usdcIn, price, quantity });
            }
        } catch (e) {
            rec.machine.transition("FAILED", this.now(), String(e));
            throw e;
        }
        rec.fills = fills;
        rec.machine.transition("SETTLED", this.now());
        return { ok: true, fills };
    }

    /** After a stopped precheck: refresh the quotes and put the proposal back in front of the Owner. */
    repropose(id: string, quotedPrices: PriceMap): void {
        const rec = this.get(id);
        if (rec.machine.state !== "REAPPROVAL_REQUIRED") {
            throw new Error(`Proposal ${id} is ${rec.machine.state}, expected REAPPROVAL_REQUIRED`);
        }
        rec.quotedPrices = quotedPrices;
        delete rec.approval;
        rec.machine.transition("PROPOSED", this.now(), "re-proposed with fresh quotes");
        this.event("PROPOSAL_CREATED", `proposal ${id} re-proposed with fresh quotes`);
    }

    proposal(id: string): ProposalRecord {
        return this.get(id);
    }

    state(id: string) {
        return this.get(id).machine.state;
    }
}