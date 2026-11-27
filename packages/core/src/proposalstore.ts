import type { Approval, ProposalState, StateChange } from "./approval";
import type { Proposal } from "./policy";
import type { PriceMap } from "./approval";

/**
 * A proposal between being offered and being executed.
 *
 * The three steps are three requests, and the process that serves one need not be the process that
 * served the last: a host runs several, replaces them freely, and rebuilds its books whenever storage
 * moves, which a proposal's own ledger entries make it do. Held only in memory, a proposal was gone
 * before the owner's signature arrived and no approval could ever succeed.
 */
export interface StoredProposal {
    id: string;
    proposal: Proposal;
    briefId?: string;
    quotedPrices: PriceMap;
    /** The approval recorded against the owner's signature, once there is one. */
    approval?: Approval;
    /** The exact approval the owner was asked to sign. */
    offered?: Approval;
    state: ProposalState;
    history: readonly StateChange[];
}

/** Where proposals live. Unlike the books this is overwritten: it holds where one has got to. */
export interface ProposalStore {
    save(id: string, document: string): Promise<void>;
    load(id: string): Promise<string | null>;
}

export class MemoryProposalStore implements ProposalStore {
    private readonly documents = new Map<string, string>();

    async save(id: string, document: string): Promise<void> {
        this.documents.set(id, document);
    }

    async load(id: string): Promise<string | null> {
        return this.documents.get(id) ?? null;
    }
}

/*
 * Every field is copied, never listed: the approval is bound to a hash of the proposal, so a field
 * added to a leg and missed here would make the restored proposal a different one from the one signed.
 */
export const serializeProposal = (p: StoredProposal): string =>
    JSON.stringify(p, (_key, value: unknown) => {
        if (typeof value === "bigint") return { $bigint: value.toString() };
        if (value instanceof Map) return { $map: [...value] };
        return value;
    });

export function parseProposal(document: string, where: string): StoredProposal {
    let parsed: Partial<StoredProposal>;
    try {
        parsed = JSON.parse(document, (_key, value: unknown) => {
            if (value !== null && typeof value === "object") {
                const tagged = value as { $bigint?: string; $map?: [unknown, unknown][] };
                if (tagged.$bigint !== undefined) return BigInt(tagged.$bigint);
                if (tagged.$map !== undefined) return new Map(tagged.$map);
            }
            return value;
        }) as Partial<StoredProposal>;
    } catch (e) {
        throw new Error(`${where}: not a readable proposal: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (
        typeof parsed.id !== "string" || typeof parsed.state !== "string" || !Array.isArray(parsed.history) ||
        !Array.isArray(parsed.proposal?.legs) || !(parsed.quotedPrices instanceof Map)
    ) {
        throw new Error(`${where}: stored proposal is missing part of itself`);
    }
    return parsed as StoredProposal;
}
