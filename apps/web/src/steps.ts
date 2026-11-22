import type { Proposal, SyncResult, ExecuteResult } from "./api";

/**
 * Where the owner is in the one sequence that matters, and what each step is allowed to be.
 *
 * The order is enforced by the agent, not by this page: there is nothing to sign before a proposal
 * exists and nothing to execute before a signature. So the rail describes a real dependency chain
 * rather than decorating the page with numbers.
 *
 * `blocked` is separate from `later` on purpose. "You cannot propose yet" and "you will propose after
 * this" look the same in a progress bar and mean completely different things to someone waiting.
 */
export type StepState = "done" | "now" | "next" | "later" | "blocked";

export const STEPS = ["Sync", "Propose", "Review", "Sign", "Execute"] as const;

export function stepStates(input: {
    proposal: Proposal | null;
    investableMinor: string;
    synced: SyncResult | null;
    fills: ExecuteResult | null;
    /** True once the approval countdown has run out, which puts the owner back on signing. */
    expired?: boolean;
}): StepState[] {
    const { proposal, synced, fills } = input;
    const investable = BigInt(input.investableMinor);

    if (fills !== null) return ["done", "done", "done", "done", "done"];

    if (proposal === null) {
        if (synced === null && investable <= 0n) return ["now", "later", "later", "later", "later"];
        if (investable > 0n) return ["done", "now", "later", "later", "later"];
        // synced, and the agent is correctly refusing to invest money it has not earned
        return ["done", "blocked", "later", "later", "later"];
    }

    if (proposal.state === "PROPOSED") return ["done", "done", "now", "next", "later"];
    if (proposal.state === "APPROVED") {
        return input.expired === true
            ? ["done", "done", "done", "now", "blocked"]
            : ["done", "done", "done", "done", "now"];
    }
    return ["done", "done", "done", "done", "done"];
}

/** The index of the step the owner is on, for the heading and the primary action. */
export function activeStep(states: StepState[]): number {
    const now = states.indexOf("now");
    return now === -1 ? states.length - 1 : now;
}
