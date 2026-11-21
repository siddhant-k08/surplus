import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
    researchBrief,
    budgetedLlm,
    estimateCostUsd,
    usdToUsdcMinor,
    loadBriefs,
    type CandidateCompany,
    type DocProvider,
    type LlmClient,
    type SavedBrief,
    type ThemeSpec,
} from "@surplus/core";
import { join } from "node:path";

export const MAX_THEMES = 3;
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 300;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD = 40;

export const DISCLAIMER =
    "Informational only, not investment advice. Every fact carries a verbatim quote from the filing it cites.";

/**
 * Validates and sanitizes buyer-supplied themes.
 *
 * A buyer's theme text ends up inside the model prompt, next to the source documents, so it is untrusted
 * input in the same way a filing is. The prompt tells the model never to follow instructions found in
 * sources, and the verification layer is the real defence: facts need verbatim quotes from real filings,
 * fits need a surviving fact from the company's own filing, evidence is computed in code, and the model
 * never touches money. On top of that this rejects the shapes that could confuse the prompt itself:
 *
 * - angle brackets, so a description cannot forge a `</source>` tag and break out of the untrusted block
 * - newlines and control characters, so it cannot fake prompt structure
 * - oversized or numerous themes, which would push the real passages out of the context window
 *
 * Anything invalid is refused with a reason rather than quietly trimmed: a buyer who paid should be told
 * their request was altered.
 */
export function normalizeThemes(raw: unknown): { ok: true; themes: ThemeSpec[] } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (!Array.isArray(raw)) return { ok: false, errors: ["themes must be an array"] };
    if (raw.length === 0) return { ok: false, errors: ["at least one theme is required"] };
    if (raw.length > MAX_THEMES) return { ok: false, errors: [`at most ${MAX_THEMES} themes per brief`] };

    const clean = (v: unknown, field: string, max: number, i: number): string | null => {
        if (typeof v !== "string") {
            errors.push(`themes[${i}].${field} must be a string`);
            return null;
        }
        const s = v.trim();
        if (s === "") {
            errors.push(`themes[${i}].${field} must not be empty`);
            return null;
        }
        if (s.length > max) {
            errors.push(`themes[${i}].${field} must be at most ${max} characters`);
            return null;
        }
        if (/[<>]/.test(s)) {
            errors.push(`themes[${i}].${field} must not contain angle brackets`);
            return null;
        }
        // reject C0 and C1 control characters, written as escapes so the source stays readable
        if (/[\u0000-\u001F\u007F-\u009F]/.test(s)) {
            errors.push(`themes[${i}].${field} must not contain newlines or control characters`);
            return null;
        }
        return s;
    };

    const themes: ThemeSpec[] = [];
    const ids = new Set<string>();
    raw.forEach((t: unknown, i: number) => {
        if (typeof t !== "object" || t === null) {
            errors.push(`themes[${i}] must be an object`);
            return;
        }
        const o = t as Record<string, unknown>;
        const name = clean(o.name, "name", MAX_NAME, i);
        const description = clean(o.description, "description", MAX_DESCRIPTION, i);

        let id: string | null = null;
        if (o.id === undefined) {
            id = name === null ? null : (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || null);
            if (id === null && name !== null) errors.push(`themes[${i}].id could not be derived from the name; send an id`);
        } else if (typeof o.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(o.id)) {
            errors.push(`themes[${i}].id must be lowercase letters, digits and hyphens, at most 40 characters`);
        } else {
            id = o.id;
        }

        let keywords: string[] | undefined;
        if (o.keywords !== undefined) {
            if (!Array.isArray(o.keywords)) {
                errors.push(`themes[${i}].keywords must be an array`);
            } else if (o.keywords.length > MAX_KEYWORDS) {
                errors.push(`themes[${i}].keywords must hold at most ${MAX_KEYWORDS} entries`);
            } else {
                const ks = o.keywords.map((k: unknown, j: number) => clean(k, `keywords[${j}]`, MAX_KEYWORD, i));
                if (!ks.includes(null)) keywords = ks as string[];
            }
        }

        if (id === null || name === null || description === null) return;
        if (ids.has(id)) {
            errors.push(`themes[${i}].id ${id} is repeated`);
            return;
        }
        ids.add(id);
        themes.push({ id, name, description, ...(keywords && { keywords }) });
    });

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, themes };
}

/** Stable key for a theme request, so the same request can reuse a brief instead of paying to redo it. */
export function themesKey(themes: readonly ThemeSpec[]): string {
    const canon = themes
        .map((t) => ({
            id: t.id,
            name: t.name.toLowerCase(),
            description: t.description.toLowerCase(),
            keywords: [...(t.keywords ?? [])].map((k) => k.toLowerCase()).sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);
}

export interface ResearchDeps {
    briefsDir: string;
    companies: () => Promise<readonly CandidateCompany[]>;
    docs: () => DocProvider;
    llm: () => LlmClient;
    provider: string;
    model: string;
    priceInputPerMTokUsd: number;
    priceOutputPerMTokUsd: number;
    /** Hard cap on what one brief may cost to produce. */
    maxSpendUsd: number;
    /** A cached brief for the same themes younger than this is served instead of generating again. */
    maxAgeSeconds: number;
    /**
     * Ceiling on what this process may spend generating briefs in total.
     *
     * `maxSpendUsd` caps one brief; without a total, N concurrent requests could spend N times that.
     */
    totalMaxSpendUsd: number;
    now?: () => Date;
}

export interface ResearchOutcome {
    saved: SavedBrief;
    cached: boolean;
    costUsdcMinor: bigint;
    issues: number;
    rejected: string[];
}

/**
 * Produces a brief for a set of themes, reusing a recent one for the same request when there is one.
 *
 * The cache is what makes selling briefs viable: generating costs real money per request, so two buyers
 * asking the same question inside the freshness window share one generation. A generated brief is capped
 * by `maxSpendUsd`, which the config refuses to set above the sale price, so a sale can never knowingly
 * cost more than it earns.
 */
export class ResearchService {
    private readonly now: () => Date;
    /** Generations in flight, keyed by theme request, so identical requests share one. */
    private readonly inFlight = new Map<string, Promise<ResearchOutcome>>();
    private spentUsd = 0;

    constructor(private readonly deps: ResearchDeps) {
        this.now = deps.now ?? (() => new Date());
        if (deps.totalMaxSpendUsd < deps.maxSpendUsd) {
            throw new Error(
                `totalMaxSpendUsd (${deps.totalMaxSpendUsd}) must be at least maxSpendUsd (${deps.maxSpendUsd})`,
            );
        }
    }

    /** What this process has spent generating briefs, and what it may still spend. */
    budget(): { spentUsd: number; remainingUsd: number } {
        return { spentUsd: this.spentUsd, remainingUsd: Math.max(0, this.deps.totalMaxSpendUsd - this.spentUsd) };
    }

    /** A brief for these themes that is young enough to serve, if one exists. */
    findCached(themes: readonly ThemeSpec[]): SavedBrief | null {
        // a zero window means no reuse at all; without this an age of exactly zero reads as fresh
        if (this.deps.maxAgeSeconds <= 0) return null;
        const key = themesKey(themes);
        const oldest = this.now().getTime() - this.deps.maxAgeSeconds * 1000;
        for (const saved of loadBriefs(this.deps.briefsDir)) {
            if (saved.themesKey !== key) continue;
            if (Date.parse(saved.brief.createdAt) < oldest) continue;
            return saved;
        }
        return null;
    }

    /**
     * A brief for these themes, reusing a recent one or a generation already under way.
     *
     * Two identical requests arriving together used to miss the cache independently and both generate,
     * paying twice for the same work. They now share one in-flight promise.
     */
    async obtain(themes: readonly ThemeSpec[]): Promise<ResearchOutcome> {
        const cached = this.findCached(themes);
        if (cached !== null) {
            return { saved: cached, cached: true, costUsdcMinor: 0n, issues: 0, rejected: [] };
        }

        const key = themesKey(themes);
        const running = this.inFlight.get(key);
        if (running !== undefined) return running;

        const started = this.generate(themes).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, started);
        return started;
    }

    private async generate(themes: readonly ThemeSpec[]): Promise<ResearchOutcome> {
        const { remainingUsd } = this.budget();
        if (remainingUsd < this.deps.maxSpendUsd) {
            throw new Error(
                `research budget exhausted: $${this.spentUsd.toFixed(4)} of $${this.deps.totalMaxSpendUsd} spent, ` +
                `which leaves less than the $${this.deps.maxSpendUsd} a brief may cost`,
            );
        }

        const companies = await this.deps.companies();
        const llm = budgetedLlm(
            this.deps.llm(),
            this.deps.maxSpendUsd,
            this.deps.priceInputPerMTokUsd,
            this.deps.priceOutputPerMTokUsd,
        );

        const now = this.now();
        // A millisecond timestamp alone collides when two requests land in the same millisecond. That would
        // overwrite the earlier brief's file, destroying a buyer's brief and its audit trail, and would make
        // two briefs share the `llm-<briefId>` cost key so the second one's model cost is silently dropped
        // as a duplicate. The random suffix keeps ids unique while the timestamp keeps them sortable.
        const briefId = `brief-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
        const result = await researchBrief(
            { briefId, themes, companies, now, disclaimer: DISCLAIMER },
            { docs: this.deps.docs(), llm },
        );

        const costUsd = estimateCostUsd(result.usage, {
            inputPerMTokUsd: this.deps.priceInputPerMTokUsd,
            outputPerMTokUsd: this.deps.priceOutputPerMTokUsd,
        });
        this.spentUsd += costUsd;
        const costUsdcMinor = usdToUsdcMinor(costUsd);

        const saved: SavedBrief = {
            file: `${briefId}.json`,
            provider: this.deps.provider,
            model: this.deps.model,
            brief: result.brief,
            costUsdcMinor,
            costUsd,
            themesKey: themesKey(themes),
        };

        // written so a later request for the same themes can reuse it, and so the owner can audit it
        mkdirSync(this.deps.briefsDir, { recursive: true });
        writeFileSync(
            join(this.deps.briefsDir, saved.file),
            JSON.stringify(
                {
                    provider: saved.provider,
                    model: saved.model,
                    themesKey: saved.themesKey,
                    themes,
                    brief: saved.brief,
                    issues: result.issues,
                    rejected: result.rejected,
                    usage: result.usage,
                    costUsd,
                    costUsdcMinor: costUsdcMinor.toString(),
                },
                null,
                2,
            ),
        );

        return { saved, cached: false, costUsdcMinor, issues: result.issues.length, rejected: result.rejected };
    }
}
