import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanBriefs, sortSavedBriefs, parseSavedBrief, type SavedBrief } from "@surplus/core";

/**
 * Where briefs live.
 *
 * Two collections, never merged: the owner's catalogue is what `GET /brief` sells and what the mandate
 * funds, and the custom collection holds what a buyer commissioned. One store would let the cheap route
 * serve a premium custom brief and would feed unfunded themes to the allocator.
 *
 * A port, because the catalogue is repository content that ships with the deployment while a
 * buyer-commissioned brief is written at runtime and has to survive a restart wherever the process runs.
 * Async because a database is.
 */

/** A brief file as it is stored: the whole document, not just the parts the agent reads back. */
export interface BriefDocument {
    provider: string;
    model: string;
    themesKey?: string | undefined;
    [key: string]: unknown;
}

export interface BriefBackend {
    /** Every readable brief, newest first. */
    list(): Promise<SavedBrief[]>;
    /**
     * Briefs that could not be read, with why.
     *
     * Surfaced rather than thrown: one truncated file used to take down the paid route, the research
     * cache and the investing loop at once. A skipped brief means its model cost is missing from the
     * ledger, so callers that account for money have to report these.
     */
    problems(): Promise<{ file: string; error: string }[]>;
    /** Stores a brief. Idempotent on the brief id. */
    save(saved: SavedBrief, document: BriefDocument): Promise<void>;
    /**
     * What every brief in this collection cost to produce, in USDC minor units.
     *
     * The durable answer to "how much has the agent spent generating briefs". Kept on the port rather
     * than summed by the caller because a database can answer it without reading every document back.
     */
    totalCostUsdcMinor(): Promise<bigint>;
}

/** Sums what a list of briefs cost. The obvious implementation, shared by the backends that have to. */
export const sumCost = (briefs: readonly SavedBrief[]): bigint =>
    briefs.reduce((total, b) => total + b.costUsdcMinor, 0n);

/** Briefs as JSON files in a directory. */
export class DirBriefBackend implements BriefBackend {
    constructor(readonly dir: string) {}

    async list(): Promise<SavedBrief[]> {
        return scanBriefs(this.dir).briefs;
    }

    async problems(): Promise<{ file: string; error: string }[]> {
        return scanBriefs(this.dir).problems;
    }

    async save(saved: SavedBrief, document: BriefDocument): Promise<void> {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(join(this.dir, saved.file), JSON.stringify(document, null, 2));
    }

    async totalCostUsdcMinor(): Promise<bigint> {
        return sumCost(await this.list());
    }
}

/** Briefs held in memory. For tests, and for a catalogue injected rather than read off a disk. */
export class MemoryBriefBackend implements BriefBackend {
    private readonly briefs = new Map<string, SavedBrief>();

    constructor(initial: readonly SavedBrief[] = []) {
        for (const b of initial) this.briefs.set(b.brief.id, b);
    }

    async list(): Promise<SavedBrief[]> {
        return sortSavedBriefs([...this.briefs.values()]);
    }

    async problems(): Promise<{ file: string; error: string }[]> {
        return [];
    }

    async save(saved: SavedBrief, _document: BriefDocument): Promise<void> {
        if (this.briefs.has(saved.brief.id)) return;
        this.briefs.set(saved.brief.id, saved);
    }

    async totalCostUsdcMinor(): Promise<bigint> {
        return sumCost(await this.list());
    }
}

/**
 * Reads a stored brief document back into the shape the agent uses.
 *
 * Shared by every backend so the validation is the same whether the document came off a disk or out of a
 * database: a brief with no recorded cost is an error, not a zero, because a zero understates what the
 * agent spent.
 */
export function savedFromDocument(file: string, document: unknown): SavedBrief {
    return parseSavedBrief(file, JSON.stringify(document));
}

/**
 * Whether a sale pays for the brief it sells.
 *
 * A catalogue brief is generated once and sold many times, so its cost is amortized and the agent
 * cannot know in advance how many copies will move. The only figure available at start-up is what
 * the catalogue has already cost, so this is the honest version of the question: averaged over the
 * briefs on hand, does one sale cover one brief?
 *
 * It exists because the answer was no for days and nothing said so. At $0.01 against a $0.021 brief,
 * every sale put the agent further behind, `surplus.investable` stayed at zero, and the entire
 * investing half could never run. The symptom was silence.
 *
 * Returns null when there is nothing to average, which is not a fault: a fresh deployment has an
 * empty catalogue, and a catalogue of briefs that cost nothing to make is not a pricing error.
 */
export function unitEconomics(
    priceUsdcMinor: bigint,
    totalCostUsdcMinor: bigint,
    briefs: number,
): { perBriefUsdcMinor: bigint; covers: number | null; belowCost: boolean } | null {
    if (briefs <= 0) return null;
    const perBrief = totalCostUsdcMinor / BigInt(briefs);
    return {
        perBriefUsdcMinor: perBrief,
        // a ratio for the eye only: every comparison that decides anything stays in integers
        covers: perBrief === 0n ? null : Number(priceUsdcMinor) / Number(perBrief),
        belowCost: perBrief > 0n && priceUsdcMinor < perBrief,
    };
}
