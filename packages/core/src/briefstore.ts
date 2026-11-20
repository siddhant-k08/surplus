import { readdirSync, readFileSync } from "node:fs";
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
    };
}

/** Newest first by `brief.createdAt`. */
export function sortSavedBriefs(briefs: readonly SavedBrief[]): SavedBrief[] {
    return [...briefs].sort((a, b) => Date.parse(b.brief.createdAt) - Date.parse(a.brief.createdAt));
}

/** Reads every brief in a directory, newest first. */
export function loadBriefs(dir: string): SavedBrief[] {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return sortSavedBriefs(files.map((f) => parseSavedBrief(f, readFileSync(join(dir, f), "utf8"))));
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
