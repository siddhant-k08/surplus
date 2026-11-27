import { Ledger, type AccountId, type EntryType, type Mode } from "./ledger";
import type { MandateStore } from "./mandate";
import { formatUsdc } from "./money";
import { bookSurplus, sweepAvailable, type SurplusResult } from "./surplus";
import { checkProposal, failures, isSell, type Leg, type Proposal } from "./policy";
import { splitFill } from "./swapplan";
import { costBuckets, costOfUnits, holdingOf, positionsFromLedger, themeHoldings, themeKey } from "./positions";
import {
    ProposalMachine,
    precheck,
    proposalHash,
    type Approval,
    type PrecheckOutcome,
    type PriceMap,
} from "./approval";
import type { StoredProposal } from "./proposalstore";

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
    /** Absent on a buy. */
    side?: "sell";
    /** Sale only: USDC minor units received, and the gain or loss that taking it realized. */
    proceedsUsdc?: bigint;
    realizedUsdc?: bigint;
}

export interface ProposalRecord {
    readonly id: string;
    readonly proposal: Proposal;
    /** The brief whose research justified this basket, carried onto every fill it books. */
    readonly briefId?: string;
    quotedPrices: PriceMap;
    readonly machine: ProposalMachine;
    approval?: Approval;
    fills?: Fill[];
}

export type ProposeResult = { ok: true } | { ok: false; reasons: string[] };
export type ApproveResult = { ok: true; approval: Approval } | { ok: false; reasons: string[] };
export type ExecuteResult =
    | { ok: true; fills: Fill[]; unfilled: { symbol: string; usdcIn: bigint; reason: string }[] }
    | { ok: false; outcome: PrecheckOutcome; reasons: string[] };

/**
 * What a leg actually got, when the swap really happened.
 *
 * Keyed by leg index, because the same token can appear in more than one theme and the index is what
 * stays stable. Absent for a leg means that leg did not execute: it is not booked, and the proposal
 * does not reach SETTLED.
 */
export interface RealizedFill {
    /**
     * What the swap actually returned: token minor units on a buy, USDC minor units on a sale.
     *
     * One field because it is one thing, the `amountOut` of the swap that happened. What it counts
     * depends on which way the trade went, and the leg says which.
     */
    quantity: bigint;
    transaction: string;
    /** How much of the leg's notional this swap covered. Absent means the whole leg. */
    usdcIn?: bigint;
    /** Sale only: how many of the leg's units this swap sent. Absent means the whole leg. */
    unitsIn?: bigint;
}

/** What swaps returned, by leg index. A leg spread over several swaps has one entry for each. */
export type RealizedFills = ReadonlyMap<number, RealizedFill | readonly RealizedFill[]>;

const asList = (r: RealizedFill | readonly RealizedFill[] | undefined): readonly RealizedFill[] =>
    r === undefined ? [] : "transaction" in r ? [r] : r;

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
                case "PURCHASE_SETTLED":
                case "SALE_SETTLED":
                    // A fill carries a briefId too, but it is neither revenue nor cost for that brief: it
                    // is surplus leaving to buy something, or coming back. Folding it in here would make
                    // every settled proposal look like money the brief had earned. `backing` and
                    // `positionsFromLedger` read these instead.
                    break;
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
        /**
         * The brief this basket came out of.
         *
         * Optional because the sim demos build legs by hand with no brief behind them. When it is given,
         * every fill is booked against it, which is what lets a position be traced back to the research
         * that argued for it after a restart, when the in-memory proposal is long gone.
         */
        briefId?: string;
    }): ProposeResult {
        if (i.legs.length === 0) throw new Error("a proposal needs at least one leg");
        if (this.records.has(i.id)) throw new Error(`Proposal ${i.id} already exists`);

        const mandate = this.opts.mandates.current();
        // Units held are read from the books rather than taken from the caller. The books are the only
        // authority on what the agent owns, and a caller that passed its own figure could authorise a
        // sale of units that are not there.
        const heldUnits = new Map<string, bigint>();
        for (const [asset, p] of positionsFromLedger(this.ledger.all())) heldUnits.set(asset, p.units);
        const proposal: Proposal = {
            investable: this.ledger.balance("surplus.investable"),
            legs: i.legs,
            ...(i.held !== undefined && { held: i.held }),
            // only carried when it matters, so a buy-only proposal hashes as it always did
            ...(i.legs.some(isSell) && { heldUnits }),
        };
        const rec: ProposalRecord = {
            id: i.id,
            proposal,
            ...(i.briefId !== undefined && { briefId: i.briefId }),
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
    /**
     * Books the fills for an approved proposal.
     *
     * With no `realized` map the quantities come from the fresh quotes, which is a simulation and is
     * labelled as one. With a `realized` map the quantities are what the chain actually returned, and a
     * leg missing from it did not happen: it is not booked, and the proposal ends FAILED rather than
     * SETTLED however many of its siblings succeeded. Booking a leg that did not execute would put a
     * position in the books that does not exist in the wallet.
     */
    execute(
        id: string,
        i: {
            freshPrices: PriceMap;
            decimals: ReadonlyMap<string, number>;
            blocks?: readonly string[];
            realized?: RealizedFills;
            /**
             * When `preflight` passed, if swaps were sent on the strength of it. Expiry is judged as of
             * then: money that has already moved has to be booked however long the swaps took.
             */
            checkedAt?: Date;
        },
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
            now: i.checkedAt ?? this.now(),
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
        // Only what is spent needs covering. A sale brings money in, and requiring the investable balance
        // to cover it would refuse exactly the trade that replenishes the balance.
        const spend = rec.proposal.legs.filter((l) => !isSell(l)).reduce((a, l) => a + l.usdcIn, 0n);
        if (reasons.length === 0 && this.ledger.balance("surplus.investable") < spend) {
            reasons.push("insufficient investable surplus");
        }
        if (reasons.length > 0) {
            rec.machine.transition("REAPPROVAL_REQUIRED", this.now(), reasons.join("; "));
            this.event("REFUSAL", `proposal ${id} stopped before execution: ${reasons.join("; ")}`);
            return { ok: false, outcome: "REAPPROVAL_REQUIRED", reasons };
        }

        rec.machine.transition("EXECUTING", this.now());
        let booked;
        try {
            booked = this.bookLegs(rec, i);
        } catch (e) {
            rec.machine.transition("FAILED", this.now(), String(e));
            throw e;
        }
        rec.fills = booked.fills;
        this.close(rec, booked.unfilled);
        return { ok: true, ...booked };
    }

    /**
     * Books swaps that already happened and never reached the ledger.
     *
     * For a process that died, or gave up waiting, between a swap and its booking. There is no precheck:
     * the checks exist to stop money moving, and this money has moved. Each swap is booked under its own
     * transaction, so one already in the books is left alone and this can safely run again.
     *
     * A proposal still waiting as approved is closed here, settled if the swaps cover every leg and
     * failed otherwise. One that already ended keeps the state it ended in.
     */
    bookExecuted(id: string, realized: RealizedFills): { fills: Fill[] } {
        const rec = this.get(id);
        const open = rec.machine.state === "APPROVED";
        if (open) {
            rec.machine.transition("PRECHECK", this.now(), "booking swaps already sent");
            rec.machine.transition("EXECUTING", this.now(), "booking swaps already sent");
        }
        const { fills, unfilled } = this.bookLegs(rec, { realized, recovered: true });
        if (open) {
            rec.fills = fills;
            this.close(rec, unfilled);
        }
        return { fills };
    }

    private close(rec: ProposalRecord, unfilled: readonly unknown[]): void {
        // The money that did move is booked; a proposal that did not all happen is not settled. The owner
        // proposes again for the remainder rather than this pretending.
        if (unfilled.length === 0) return rec.machine.transition("SETTLED", this.now());
        rec.machine.transition(
            "FAILED",
            this.now(),
            `${unfilled.length} of ${rec.proposal.legs.length} legs did not fully execute`,
        );
    }

    private bookLegs(
        rec: ProposalRecord,
        i: {
            freshPrices?: PriceMap;
            decimals?: ReadonlyMap<string, number>;
            realized?: RealizedFills | undefined;
            recovered?: boolean;
        },
    ): { fills: Fill[]; unfilled: { symbol: string; usdcIn: bigint; reason: string }[] } {
        const id = rec.id;
        const fills: Fill[] = [];
        const unfilled: { symbol: string; usdcIn: bigint; reason: string }[] = [];
        // Positions as they stand, carried through the loop so two sales of the same token take their
        // cost basis in sequence rather than both costing it from the opening balance.
        const positions = positionsFromLedger(this.ledger.all());
        const booked = (prefix: string): boolean =>
            this.ledger.all().some(
                (t) => t.idempotencyKey === prefix || t.idempotencyKey?.startsWith(`${prefix}:`) === true,
            );

        // The same asset can appear in more than one theme, so the key is per leg, not per asset.
        // Legs are fixed when the proposal is created, so the index is stable across retries.
        for (const [n, leg] of rec.proposal.legs.entries()) {
            const key = leg.asset.toLowerCase();
            // absent only when there is no quote to speak of, which is when booking after the fact
            const quoted = i.freshPrices?.get(key);
            const swaps = i.realized === undefined ? [undefined] : asList(i.realized.get(n));
            const covered = swaps.reduce((a, s) => a + (s?.usdcIn ?? leg.usdcIn), 0n);
            if (covered < leg.usdcIn) {
                // the swap for this part did not happen; booking it would invent a position
                unfilled.push({ symbol: leg.symbol, usdcIn: leg.usdcIn - covered, reason: "the swap did not execute" });
            }

            for (const real of swaps) {
                const tag = real === undefined ? "SIMULATED " : i.recovered === true ? "RECOVERED " : "";
                const idempotencyKey = real === undefined
                    ? `fill:${id}:${n}:${key}`
                    : `fill:${id}:${n}:${key}:${real.transaction}`;
                if (real !== undefined && booked(idempotencyKey)) continue;
                const usdcIn = real?.usdcIn ?? leg.usdcIn;
                const common = {
                    mode: this.opts.mode,
                    at: this.now(),
                    idempotencyKey,
                    ...(real !== undefined && { txHash: real.transaction }),
                    // What justified this position, structured. The same token can be filled twice in one
                    // proposal under two themes, and these two fields are what keep those apart.
                    ...(rec.briefId !== undefined && { briefId: rec.briefId }),
                    theme: leg.theme,
                };

                if (isSell(leg)) {
                    const units = real?.unitsIn ?? leg.unitsIn!;
                    const position = positions.get(key);
                    if (position === undefined || position.units < units) {
                        throw new Error(
                            `cannot sell ${units} units of ${leg.symbol}: the books hold ${position?.units ?? 0n}`,
                        );
                    }

                    /*
                     * A sale is scoped to the theme of its leg.
                     *
                     * The same token is held under several themes at once, and which one is being sold is
                     * not a detail: trimming a theme that has drifted above its target must sell that
                     * theme's own holding, or the trim would quietly take basis from a theme that was
                     * exactly where the mandate wanted it. A whole-position exit is therefore one leg per
                     * theme rather than one leg for the token, which `exitPlan` is what produces.
                     */
                    const held = holdingOf(themeHoldings(this.ledger.all()), leg.theme, key);
                    if (held === null || held.units < units) {
                        throw new Error(
                            `cannot sell ${units} units of ${leg.symbol} under "${leg.theme}": ` +
                            `that theme holds ${held?.units ?? 0n}`,
                        );
                    }

                    // What the swap returned, or what the quote says those units are worth.
                    const proceeds =
                        real?.quantity ?? (units * quoted!) / 10n ** BigInt(i.decimals!.get(key)!);
                    const price = quoted ?? 0n;
                    // The basis of this theme's units, not the token's blended basis across every theme.
                    const cost = costOfUnits(
                        { ...position, units: held.units, costUsdcIn: held.costUsdcIn },
                        units,
                    );
                    const realized = proceeds - cost;

                    /*
                     * One entry per source of the basis being sold.
                     *
                     * Within one theme the money can still have come from several briefs, so the basis
                     * leaves the buckets it came from, in proportion, and the proceeds and the gain
                     * follow it. Booking the exit as a single entry would credit the whole unwind to one
                     * brief and leave the others showing money behind a position that has been closed.
                     */
                    const buckets = costBuckets(this.ledger.all(), key)
                        .filter((b) => themeKey(b.theme ?? null) === leg.theme);
                    const shares = buckets.length === 0
                        ? [cost]
                        : splitFill(cost, buckets.map((b) => b.costUsdcIn));
                    const proceedShares = buckets.length === 0
                        ? [proceeds]
                        : splitFill(proceeds, buckets.map((b) => b.costUsdcIn));
                    const unitShares = buckets.length === 0
                        ? [units]
                        : splitFill(units, buckets.map((b) => b.costUsdcIn));

                    for (const [b, bucket] of (buckets.length === 0 ? [undefined] : buckets).entries()) {
                        const costShare = shares[b]!;
                        const proceedShare = proceedShares[b]!;
                        const unitShare = unitShares[b]!;
                        if (costShare === 0n && proceedShare === 0n) continue;
                        const realizedShare = proceedShare - costShare;
                        this.ledger.post({
                            mode: common.mode,
                            at: common.at,
                            ...(common.txHash !== undefined && { txHash: common.txHash }),
                            // Where this slice of basis came from, not where the proposal came from.
                            ...(bucket?.briefId !== undefined && { briefId: bucket.briefId }),
                            ...(bucket?.theme !== undefined && { theme: bucket.theme }),
                            type: "SALE_SETTLED",
                            idempotencyKey: `${common.idempotencyKey}:${b}`,
                            units: -unitShare,
                            memo:
                                `${tag}sale ${leg.symbol}: ${unitShare} units` +
                                (quoted === undefined ? "" : ` at ${quoted}`) +
                                ` => ${formatUsdc(proceedShare)} USDC against ${formatUsdc(costShare)} cost` +
                                (bucket === undefined ? "" : ` (${bucket.briefId ?? "unattributed"}/${bucket.theme ?? "no theme"})`),
                            lines: [
                                // the basis leaves the position, the money comes back as investable, and
                                // the difference is the only part that is profit or loss
                                { account: `positions.${key}`, amount: -costShare },
                                { account: "surplus.investable", amount: proceedShare },
                                // Omitted when a slice lands exactly on its basis: the ledger refuses a
                                // zero line, and the entry balances without it.
                                ...(realizedShare === 0n ? [] : [{ account: "pnl.realized" as const, amount: -realizedShare }]),
                            ],
                        });
                    }

                    position.units -= units;
                    position.costUsdcIn -= cost;
                    position.realizedUsdc += realized;
                    fills.push({
                        asset: key, symbol: leg.symbol, usdcIn, price,
                        quantity: units, side: "sell", proceedsUsdc: proceeds, realizedUsdc: realized,
                    });
                    continue;
                }

                const quantity =
                    real?.quantity ?? (usdcIn * 10n ** BigInt(i.decimals!.get(key)!)) / quoted!;
                const price = quoted ?? 0n;
                this.ledger.post({
                    ...common,
                    type: "PURCHASE_SETTLED",
                    units: quantity,
                    memo:
                        `${tag}fill ${leg.symbol}: ${formatUsdc(usdcIn)} USDC` +
                        (quoted === undefined ? "" : ` at ${quoted}`) +
                        ` => ${quantity} units`,
                    lines: [
                        { account: `positions.${key}`, amount: usdcIn },
                        { account: "surplus.investable", amount: -usdcIn },
                    ],
                });
                const open = positions.get(key)
                    ?? { asset: key, units: 0n, costUsdcIn: 0n, realizedUsdc: 0n, buys: 0, sells: 0, buysWithoutUnits: 0 };
                open.units += quantity;
                open.costUsdcIn += usdcIn;
                positions.set(key, open);
                fills.push({ asset: key, symbol: leg.symbol, usdcIn, price, quantity });
            }
        }
        return { fills, unfilled };
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

    /**
     * What would stop this proposal executing, asked without changing anything.
     *
     * For a caller about to send real swaps, which cannot be taken back: `execute` makes the same
     * checks, but it books what happened, so by then the money has moved.
     */
    preflight(id: string, freshPrices: PriceMap, at: Date): string[] {
        const rec = this.get(id);
        if (rec.machine.state !== "APPROVED" || !rec.approval) {
            throw new Error(`Proposal ${id} is ${rec.machine.state}, expected APPROVED`);
        }
        const mandate = this.opts.mandates.current();
        const { reasons } = precheck({
            approval: rec.approval,
            proposal: rec.proposal,
            mandate: { version: mandate.version, hash: mandate.hash, terms: mandate.terms },
            now: at,
            quotedPrices: rec.quotedPrices,
            freshPrices,
        });
        const spend = rec.proposal.legs.filter((l) => !isSell(l)).reduce((a, l) => a + l.usdcIn, 0n);
        if (this.ledger.balance("surplus.investable") < spend) reasons.push("insufficient investable surplus");
        return reasons;
    }

    proposal(id: string): ProposalRecord {
        return this.get(id);
    }

    /** A proposal as storage needs it, without what only the offering caller knows. */
    exportProposal(id: string): Omit<StoredProposal, "offered"> {
        const rec = this.get(id);
        return {
            id: rec.id,
            proposal: rec.proposal,
            ...(rec.briefId !== undefined && { briefId: rec.briefId }),
            quotedPrices: rec.quotedPrices,
            ...(rec.approval !== undefined && { approval: rec.approval }),
            state: rec.machine.state,
            history: rec.machine.history(),
        };
    }

    /** Puts a stored proposal back, replacing whatever this process remembered about it. */
    restoreProposal(stored: StoredProposal): void {
        this.records.set(stored.id, {
            id: stored.id,
            proposal: stored.proposal,
            ...(stored.briefId !== undefined && { briefId: stored.briefId }),
            quotedPrices: stored.quotedPrices,
            ...(stored.approval !== undefined && { approval: stored.approval }),
            machine: ProposalMachine.restore(stored.state, stored.history),
        });
    }

    state(id: string) {
        return this.get(id).machine.state;
    }
}