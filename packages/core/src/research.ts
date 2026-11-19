import type { Candidate } from "./allocator";

export type SourceTier = 1 | 2 | 3 | 4 | 5;
export type ClaimType = "fact" | "assumption" | "opinion";
export type Confidence = "low" | "medium" | "high";

export interface Source {
    id: string;
    tier: SourceTier;
    title: string;
    publisher: string;
    url: string;
    publishedAt: string | null;
    retrievedAt: string;
    excerpt: string;
}

export interface Claim {
    id: string;
    type: ClaimType;
    text: string;
    sourceIds: string[];
    confidence?: Confidence;
    asOf?: string;
}

export interface Fit {
    asset: string;
    symbol: string;
    fit: number; // 0 to 5
    evidence: number; // 0 to 5
    claimIds: string[];
}

export interface ThemeBrief {
    themeId: string;
    claims: Claim[];
    fits: Fit[];
    gap: boolean;
    gapReason?: string;
}

export interface Brief {
    id: string;
    createdAt: string;
    sources: Source[];
    themes: ThemeBrief[];
    disclaimer: string;
}

export interface ValidationIssue {
    path: string;
    rule: string;
    message: string;
}

export interface ValidationContext {
    eligible: ReadonlySet<string>; // lowercase addresses
}

function isHttps(url: string): boolean {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}

export function validateBrief(b: Brief, ctx: ValidationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const add = (path: string, rule: string, message: string) => issues.push({ path, rule, message });

    const sources = new Map<string, Source>();
    b.sources.forEach((s, i) => {
        const p = `sources[${i}]`;
        if (sources.has(s.id)) add(p, "uniqueId", `duplicate source id ${s.id}`);
        else sources.set(s.id, s);
        if (![1, 2, 3, 4, 5].includes(s.tier)) add(p, "tier", `tier must be 1 to 5, got ${s.tier}`);
        if (!isHttps(s.url)) add(p, "url", "source url must be a valid https URL");
        if (Number.isNaN(Date.parse(s.retrievedAt))) add(p, "retrievedAt", "retrievedAt is not a valid date");
        if (s.excerpt.trim() === "") add(p, "excerpt", "a stored excerpt is required");
    });

    const claims = new Map<string, Claim>();
    b.themes.forEach((th, ti) => {
        th.claims.forEach((c, ci) => {
            const p = `themes[${ti}].claims[${ci}]`;
            if (claims.has(c.id)) add(p, "uniqueId", `duplicate claim id ${c.id}`);
            else claims.set(c.id, c);

            const known: Source[] = [];
            for (const id of c.sourceIds) {
                const s = sources.get(id);
                if (s) known.push(s);
                else add(p, "sourceResolves", `unknown source ${id}`);
            }

            if (c.type === "fact") {
                const strong = known.some((s) => s.tier <= 3);
                const publishers = new Set(known.filter((s) => s.tier === 4).map((s) => s.publisher));
                if (!strong && publishers.size < 2) {
                    add(p, "factEvidence", "a fact needs a tier 1 to 3 source or two independent tier 4 sources");
                }
            }
            if (c.type === "assumption" && (c.asOf === undefined || Number.isNaN(Date.parse(c.asOf)))) {
                add(p, "assumptionDate", "an assumption needs a valid asOf date");
            }
            if (c.type === "opinion" && c.confidence === undefined) {
                add(p, "opinionConfidence", "an opinion needs a confidence label");
            }
        });
    });

    b.themes.forEach((th, ti) => {
        const p = `themes[${ti}]`;
        if (th.gap) {
            if (!th.gapReason || th.gapReason.trim() === "") add(p, "gapReason", "a gap needs a reason");
            if (th.fits.length > 0) add(p, "gapHasFits", "a theme marked as a gap cannot list fits");
        } else if (th.fits.length === 0) {
            add(p, "themeEmpty", "a theme with no fits must be marked as a gap");
        }

        th.fits.forEach((f, fi) => {
            const fp = `${p}.fits[${fi}]`;
            if (!ctx.eligible.has(f.asset.toLowerCase())) {
                add(fp, "eligible", `${f.symbol} is not on the eligible list`);
            }
            for (const [name, v] of [["fit", f.fit], ["evidence", f.evidence]] as const) {
                if (!Number.isInteger(v) || v < 0 || v > 5) add(fp, "scoreRange", `${name} must be an integer 0 to 5`);
            }
            let hasFact = false;
            for (const id of f.claimIds) {
                const c = claims.get(id);
                if (!c) add(fp, "claimResolves", `unknown claim ${id}`);
                else if (c.type === "fact") hasFact = true;
            }
            if (!hasFact) add(fp, "fitNeedsFact", "each fit must cite at least one fact claim");
        });
    });

    if (b.disclaimer.trim() === "") add("disclaimer", "disclaimer", "a disclaimer is required");
    return issues;
}

/** Turns scored fits into allocator candidates. Floats are used for ranking only, then rounded to integers. */
export function toCandidates(
    fits: readonly Fit[],
    liquidity: ReadonlyMap<string, number>,
    floor = 3,
): Candidate[] {
    return fits
        .filter((f) => f.fit >= floor)
        .map((f) => {
            const asset = f.asset.toLowerCase();
            const liq = Math.min(5, Math.max(0, liquidity.get(asset) ?? 0));
            const rank = 0.5 * f.fit + 0.2 * f.evidence + 0.3 * liq;
            return { asset, symbol: f.symbol, weight: Math.max(1, Math.round(rank * 100)) };
        });
}