import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief } from "./research";

/** A brief as written to disk by the research demo, with the metered model cost that produced it. */
export interface SavedBrief {
    file: string;
    provider: string;
    model: string;
    brief: Brief;
    costUsdcMinor: bigint;
    costUsd: number;
    /** Stable key of the theme request this brief answers, when it was generated for one. */
    themesKey?: string;
}

/**
 * Parses one saved brief file. The cost is stored as a decimal string of USDC minor units, so it never
 * passes through a float. Anything missing is an error rather than a default: a brief with no recorded
 * cost would understate what the agent spent.
 */
export function parseSavedBrief(file: string, text: string): SavedBrief {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) throw new Error(`${file} is not an object`);
    const r = raw as Record<string, unknown>;
    const brief = r.brief as Brief | undefined;
    if (brief === undefined || typeof brief.id !== "string" || !Array.isArray(brief.themes)) {
        throw new Error(`${file} has no usable brief`);
    }
    if (typeof r.costUsdcMinor !== "string" || !/^\d+$/.test(r.costUsdcMinor)) {
        throw new Error(`${file} has no costUsdcMinor`);
    }
    return {
        file,
        provider: typeof r.provider === "string" ? r.provider : "unknown",
        model: typeof r.model === "string" ? r.model : "unknown",
        brief,
        costUsdcMinor: BigInt(r.costUsdcMinor),
        costUsd: typeof r.costUsd === "number" ? r.costUsd : 0,
        ...(typeof r.themesKey === "string" && { themesKey: r.themesKey }),
    };
}

/** Newest first by `brief.createdAt`. */
export function sortSavedBriefs(briefs: readonly SavedBrief[]): SavedBrief[] {
    return [...briefs].sort((a, b) => Date.parse(b.brief.createdAt) - Date.parse(a.brief.createdAt));
}

export interface BriefScan {
    briefs: SavedBrief[];
    /** Files that could not be read, with why. A brief skipped here has its cost missing from the books. */
    problems: { file: string; error: string }[];
}

/**
 * Reads every brief in a directory, newest first, skipping files that cannot be parsed.
 *
 * One truncated file used to take down everything that reads briefs: the paid route, the research cache
 * and the investing loop. An interrupted write produces exactly that, so a bad file is reported instead of
 * thrown. Callers that account for money must surface `problems`, because a skipped brief means its model
 * cost is missing from the ledger.
 */
export function scanBriefs(dir: string): BriefScan {
    if (!existsSync(dir)) return { briefs: [], problems: [] };
    const briefs: SavedBrief[] = [];
    const problems: { file: string; error: string }[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
            briefs.push(parseSavedBrief(file, readFileSync(join(dir, file), "utf8")));
        } catch (e) {
            problems.push({ file, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return { briefs: sortSavedBriefs(briefs), problems };
}

/** Readable briefs in a directory, newest first. Unreadable files are skipped; see `scanBriefs`. */
export function loadBriefs(dir: string): SavedBrief[] {
    return scanBriefs(dir).briefs;
}

/** The newest brief in a directory. Throws when the directory holds none. */
export function loadLatestBrief(dir: string): SavedBrief {
    const all = loadBriefs(dir);
    const newest = all[0];
    if (newest === undefined) {
        throw new Error(`No briefs in ${dir}. Run "npx tsx scripts/demo-research.ts" first.`);
    }
    return newest;
}
