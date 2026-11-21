import { Ledger, type AccountId, type EntryType, type Mode } from "./ledger";
import type { MandateStore } from "./mandate";
import { formatUsdc } from "./money";
import { bookSurplus, sweepAvailable, type SurplusResult } from "./surplus";
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
    /** Revenue and costs already folded into a sweep, so a later sweep only sees what is new. */
    sweptRevenue: bigint;
    sweptCosts: bigint;
    /** Net that has been accounted for but not yet swept. Negative while a brief is behind. */
    carried: bigint;
    /** The most recent sweep, for reporting. */
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
        // Always rebuild: a caller who hands over a ledger with history must not have to remember to ask.
        if (this.ledger.all().length > 0) this.rebuildFromLedger();
    }

    /**
     * Restores the per-brief tallies and the seen-id sets from the ledger.
     *
     * Without this, a Treasury handed a restored ledger would think every brief had zero revenue, so
     * `settleBrief` would compute a surplus from nothing. Double booking is already prevented by the
     * ledger's own idempotency index; this is about the derived state being right as well.
     *
     * Everything needed is in the entries: the `briefId` field says what each movement was for, the
     * amounts are in the lines, and `net` and `shortfall` follow from revenue and costs.
     */
    private rebuildFromLedger(): void {
        const booked = new Map<string, { reserveTopUp: bigint; surplus: bigint; investable: bigint; retained: bigint }>();

        for (const tx of this.ledger.all()) {
            const key = tx.idempotencyKey;
            const line = (account: AccountId): bigint =>
                tx.lines.find((l) => l.account === account)?.amount ?? 0n;

            switch (tx.type) {
                case "PAYMENT_RECEIVED": {
                    if (key?.startsWith("pay:") === true) this.seenPayments.add(key.slice(4));
                    if (tx.briefId !== undefined) this.brief(tx.briefId).revenue += line("cash.operating");
                    break;
                }
                case "COST_ACCRUED": {
                    if (key?.startsWith("cost:") === true) this.seenCosts.add(key.slice(5));
                    // the cash line is negative; the cost is its magnitude
                    if (tx.briefId !== undefined) this.brief(tx.briefId).costs += -line("cash.operating");
                    break;
                }
                case "RESERVE_TOPUP": {
                    if (tx.briefId === undefined) break;
                    this.brief(tx.briefId);
                    const b = booked.get(tx.briefId) ?? { reserveTopUp: 0n, surplus: 0n, investable: 0n, retained: 0n };
                    b.reserveTopUp += line("reserve");
                    booked.set(tx.briefId, b);
                    break;
                }
                case "SURPLUS_ALLOCATED": {
                    if (tx.briefId === undefined) break;
                    this.brief(tx.briefId);
                    const b = booked.get(tx.briefId) ?? { reserveTopUp: 0n, surplus: 0n, investable: 0n, retained: 0n };
                    b.surplus += -line("cash.operating");
                    b.investable += line("surplus.investable");
                    b.retained += line("surplus.retained");
                    booked.set(tx.briefId, b);
                    break;
                }
                default:
                    break;
            }
        }

        // Restore the sweep counters for every brief the ledger knows about, not only the ones that booked
        // a sweep. Everything in the ledger has been accounted for, so what is left to carry is the brief's
        // net minus what was actually swept out of it. Without this a restored treasury would try to sweep
        // the brief's whole lifetime again and collide with its own idempotency key.
        const ZERO = { reserveTopUp: 0n, surplus: 0n, investable: 0n, retained: 0n };
        for (const [briefId, acct] of this.briefs) {
            const b = booked.get(briefId) ?? ZERO;
            acct.sweptRevenue = acct.revenue;
            acct.sweptCosts = acct.costs;
            acct.carried = acct.revenue - acct.costs - (b.reserveTopUp + b.surplus);
            acct.result = {
                net: acct.revenue - acct.costs,
                shortfall: acct.carried < 0n ? -acct.carried : 0n,
                reserveTopUp: b.reserveTopUp,
                surplus: b.surplus,
                investable: b.investable,
                retained: b.retained,
            };
        }
    }

    private brief(id: string): BriefAccount {
        let b = this.briefs.get(id);
        if (!b) {
            b = { revenue: 0n, costs: 0n, sweptRevenue: 0n, sweptCosts: 0n, carried: 0n };
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
    /** `memo` is free-form provenance; pass the brief id so a persisted entry says what was sold. */
    receivePayment(i: { id: string; briefId: string; amount: bigint; txHash?: string; memo?: string }): void {
        if (i.amount <= 0n) throw new Error("payment amount must be positive");
        if (this.seenPayments.has(i.id)) return;
        this.ledger.post({
            type: "PAYMENT_RECEIVED",
            mode: this.opts.mode,
            at: this.now(),
            idempotencyKey: `pay:${i.id}`,
            briefId: i.briefId,
            ...(i.txHash !== undefined && { txHash: i.txHash }),
            ...(i.memo !== undefined && { memo: i.memo }),
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
            briefId: i.briefId,
            ...(i.memo !== undefined && { memo: i.memo }),
            lines: [
                { account: COST_ACCOUNT[i.kind], amount: i.amount },
                { account: "cash.operating", amount: -i.amount },
            ],
        });
        this.seenCosts.add(i.id);
        this.brief(i.briefId).costs += i.amount;
    }

    /**
     * Sweeps whatever a brief has newly earned into the reserve and the surplus split.
     *
     * Settlement is incremental, not once per brief. A brief can be bought again after it was first
     * settled, and that revenue has to reach the surplus too; an earlier version cached the first result
     * and returned it forever, so every later sale sat in operating cash and never became investable.
     *
     * Only the change since the last sweep is considered. A brief that is behind carries the deficit
     * forward in `carried`, so later revenue first makes good the loss and only the remainder is swept.
     * The idempotency key covers the cumulative revenue and costs, so calling this twice with nothing new
     * books nothing rather than booking twice.
     */
    settleBrief(briefId: string): SurplusResult {
        const b = this.brief(briefId);
        const terms = this.opts.mandates.current().terms;

        const newRevenue = b.revenue - b.sweptRevenue;
        const newCosts = b.costs - b.sweptCosts;
        b.sweptRevenue = b.revenue;
        b.sweptCosts = b.costs;
        // what this sweep decides on: whatever is new, plus any deficit still carried from before
        const considered = newRevenue - newCosts + b.carried;
        b.carried = considered;

        const available = considered > 0n ? considered : 0n;
        const swept = sweepAvailable({
            available,
            reserveBalance: this.ledger.balance("reserve"),
            reserveTarget: terms.reserveTargetUsdc,
            investShareBps: terms.investShareBps,
        });
        // everything available is either moved to the reserve or split as surplus, so only a deficit carries
        b.carried -= swept.reserveTopUp + swept.surplus;

        const result: SurplusResult = {
            net: considered,
            shortfall: b.carried < 0n ? -b.carried : 0n,
            ...swept,
        };
        bookSurplus(this.ledger, result, {
            mode: this.opts.mode,
            at: this.now(),
            key: `brief-${briefId}:r${b.revenue.toString()}:c${b.costs.toString()}`,
            briefId,
        });
        b.result = result;
        return result;
    }

    createProposal(i: {
        id: string;
        legs: readonly Leg[];
        quotedPrices: PriceMap;
        /** Already-held exposure per asset, so the company cap covers the whole portfolio. */
        held?: ReadonlyMap<string, bigint>;
    }): ProposeResult {
        if (i.legs.length === 0) throw new Error("a proposal needs at least one leg");
        if (this.records.has(i.id)) throw new Error(`Proposal ${i.id} already exists`);

        const mandate = this.opts.mandates.current();
        const proposal: Proposal = {
            investable: this.ledger.balance("surplus.investable"),
            legs: i.legs,
            ...(i.held !== undefined && { held: i.held }),
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

    /**
     * Records the owner's approval of a proposal.
     *
     * `maxUsdcIn` and both hashes are always computed here from the proposal and the current mandate, never
     * taken from the caller: those are the facts the owner's signature is supposed to be about, so letting
     * a caller supply them would let a forged approval authorize more than the owner agreed to.
     *
     * `expiresAt` may be supplied so it can match a signature the owner already made, but it is clamped to
     * the mandate's `approvalExpirySeconds`: a signature cannot widen the window the user set.
     */
    approve(
        id: string,
        by: string,
        opts: { expiresAt?: string; signature?: string; expect?: Approval } = {},
    ): ApproveResult {
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

        const latest = this.now().getTime() + mandate.terms.approvalExpirySeconds * 1000;
        let expiresAt = new Date(latest).toISOString();
        if (opts.expiresAt !== undefined) {
            const asked = Date.parse(opts.expiresAt);
            if (Number.isNaN(asked)) throw new Error(`expiresAt is not a date: ${opts.expiresAt}`);
            if (asked > latest) {
                throw new Error(
                    `expiresAt ${opts.expiresAt} is beyond the mandate's approval window of ${mandate.terms.approvalExpirySeconds}s`,
                );
            }
            if (asked <= this.now().getTime()) throw new Error(`expiresAt ${opts.expiresAt} is already past`);
            expiresAt = new Date(asked).toISOString();
        }
        const approval: Approval = {
            proposalHash: proposalHash(rec.proposal, mandate.hash),
            mandateVersion: mandate.version,
            mandateHash: mandate.hash,
            maxUsdcIn: sumLegs(rec.proposal.legs),
            expiresAt,
        };
        // When the caller says what was authorized, every field has to match what the agent computed.
        // The owner's signature covers the mandate version and hash, so if the mandate moved between the
        // offer and this call the approval being recorded is not the one that was authorized.
        if (opts.expect !== undefined) {
            const e = opts.expect;
            const mismatch: string[] = [];
            if (e.proposalHash !== approval.proposalHash) mismatch.push("proposalHash");
            if (e.mandateVersion !== approval.mandateVersion) {
                mismatch.push(`mandateVersion (authorized v${e.mandateVersion}, current v${approval.mandateVersion})`);
            }
            if (e.mandateHash !== approval.mandateHash) mismatch.push("mandateHash");
            if (e.maxUsdcIn !== approval.maxUsdcIn) mismatch.push("maxUsdcIn");
            if (Date.parse(e.expiresAt) !== Date.parse(approval.expiresAt)) mismatch.push("expiresAt");
            if (mismatch.length > 0) {
                const reason = `authorization does not match the current proposal: ${mismatch.join(", ")}`;
                this.event("REFUSAL", `proposal ${id} not approved: ${reason}`);
                return { ok: false, reasons: [reason] };
            }
        }

        rec.approval = approval;
        rec.machine.transition("APPROVED", this.now());
        this.event(
            "APPROVAL_RECORDED",
            `proposal ${id} approved by ${by}, expires ${expiresAt}` +
            (opts.signature === undefined ? "" : `, signature ${opts.signature.slice(0, 18)}...`),
        );
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
            // The same asset can appear in more than one theme, so the key is per leg, not per asset.
            // Legs are fixed when the proposal is created, so the index is stable across retries.
            for (const [n, leg] of rec.proposal.legs.entries()) {
                const key = leg.asset.toLowerCase();
                const price = i.freshPrices.get(key)!;
                const quantity = (leg.usdcIn * 10n ** BigInt(i.decimals.get(key)!)) / price;
                const tag = this.opts.mode === "sim" ? "SIMULATED " : "";
                this.ledger.post({
                    type: "PURCHASE_SETTLED",
                    mode: this.opts.mode,
                    at: this.now(),
                    idempotencyKey: `fill:${id}:${n}:${key}`,
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