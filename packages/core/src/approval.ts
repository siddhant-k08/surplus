import { createHash } from "node:crypto";
import { canonicalJson, type MandateTerms } from "./mandate";
import { checkProposal, failures, type Proposal } from "./policy";

export type ProposalState =
    | "DRAFT"
    | "PROPOSED"
    | "APPROVED"
    | "PRECHECK"
    | "EXECUTING"
    | "SETTLED"
    | "REJECTED"
    | "EXPIRED"
    | "REAPPROVAL_REQUIRED"
    | "FAILED";

const TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
    DRAFT: ["PROPOSED", "REJECTED"],
    PROPOSED: ["APPROVED", "REJECTED", "DRAFT"],
    APPROVED: ["PRECHECK", "EXPIRED", "REJECTED"],
    PRECHECK: ["EXECUTING", "REAPPROVAL_REQUIRED", "EXPIRED"],
    EXECUTING: ["SETTLED", "FAILED"],
    SETTLED: [],
    REJECTED: [],
    EXPIRED: [],
    REAPPROVAL_REQUIRED: ["PROPOSED", "REJECTED"],
    FAILED: [],
};

export interface StateChange {
    from: ProposalState;
    to: ProposalState;
    at: string;
    reason?: string;
}

export class ProposalMachine {
    private current: ProposalState = "DRAFT";
    private readonly log: StateChange[] = [];

    get state(): ProposalState {
        return this.current;
    }

    canTransition(to: ProposalState): boolean {
        return TRANSITIONS[this.current].includes(to);
    }

    transition(to: ProposalState, at: Date, reason?: string): void {
        if (!this.canTransition(to)) {
            throw new Error(`Illegal transition ${this.current} -> ${to}`);
        }
        this.log.push({
            from: this.current,
            to,
            at: at.toISOString(),
            ...(reason !== undefined && { reason }),
        });
        this.current = to;
    }

    history(): readonly StateChange[] {
        return this.log;
    }
}

export interface Approval {
    proposalHash: string;
    mandateVersion: number;
    mandateHash: string;
    maxUsdcIn: bigint;
    expiresAt: string; // ISO
}

export function proposalHash(p: Proposal, mandateHash: string): string {
    return createHash("sha256")
        .update(canonicalJson({ proposal: p, mandateHash }))
        .digest("hex");
}

/** Price unit: USDC minor units per one whole token. */
export type PriceMap = ReadonlyMap<string, bigint>;

export function driftBps(quoted: bigint, fresh: bigint): bigint {
    if (quoted <= 0n) throw new Error("quoted price must be positive");
    const diff = fresh > quoted ? fresh - quoted : quoted - fresh;
    return (diff * 10_000n) / quoted;
}

export interface PrecheckInput {
    approval: Approval;
    proposal: Proposal;
    mandate: { version: number; hash: string; terms: MandateTerms };
    now: Date;
    quotedPrices: PriceMap;
    freshPrices: PriceMap;
}

export type PrecheckOutcome = "PROCEED" | "EXPIRED" | "REAPPROVAL_REQUIRED";

export interface PrecheckResult {
    outcome: PrecheckOutcome;
    reasons: string[];
}

export function precheck(i: PrecheckInput): PrecheckResult {
    if (i.now.getTime() > Date.parse(i.approval.expiresAt)) {
        return { outcome: "EXPIRED", reasons: [`approval expired at ${i.approval.expiresAt}`] };
    }

    const reasons: string[] = [];

    if (i.approval.mandateVersion !== i.mandate.version || i.approval.mandateHash !== i.mandate.hash) {
        reasons.push(
            `mandate changed since approval (approved v${i.approval.mandateVersion}, current v${i.mandate.version})`,
        );
    }

    if (i.approval.proposalHash !== proposalHash(i.proposal, i.approval.mandateHash)) {
        reasons.push("proposal differs from the one that was approved");
    }

    const total = i.proposal.legs.reduce((a, l) => a + l.usdcIn, 0n);
    if (total > i.approval.maxUsdcIn) {
        reasons.push(`total ${total} exceeds approved maximum ${i.approval.maxUsdcIn}`);
    }

    const tolerance = BigInt(i.mandate.terms.driftToleranceBps);
    for (const leg of i.proposal.legs) {
        const key = leg.asset.toLowerCase();
        const quoted = i.quotedPrices.get(key);
        const fresh = i.freshPrices.get(key);
        if (quoted === undefined || fresh === undefined || quoted <= 0n || fresh <= 0n) {
            reasons.push(`no usable fresh quote for ${leg.symbol}`);
            continue;
        }
        const drift = driftBps(quoted, fresh);
        if (drift > tolerance) {
            reasons.push(`${leg.symbol} moved ${drift} bps (limit ${tolerance} bps)`);
        }
    }

    for (const f of failures(checkProposal(i.proposal, i.mandate.terms))) {
        reasons.push(`policy ${f.rule}: ${f.detail}`);
    }

    return { outcome: reasons.length === 0 ? "PROCEED" : "REAPPROVAL_REQUIRED", reasons };
}