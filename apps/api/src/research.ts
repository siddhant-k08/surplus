import { createHash, randomUUID } from "node:crypto";
import {
    researchBrief,
    budgetedLlm,
    estimateCostUsd,
    usdToUsdcMinor,
    type CandidateCompany,
    BASE_REGISTRY,
    type DocProvider,
    type LlmClient,
    type SavedBrief,
    type ThemeSpec,
} from "@surplus/core";
import type { BriefBackend } from "./briefs";
import { log } from "./log";
import { MemoryReservations, type Reservations } from "./reservations";

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
    /** Where a commissioned brief is stored and where the cache looks. Never the owner's catalogue. */
    briefs: BriefBackend;
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
     * Ceiling on what the agent may spend generating briefs, over the life of the deployment.
     *
     * `maxSpendUsd` caps one brief; without a total, N concurrent requests could spend N times that.
     */
    totalMaxSpendUsd: number;
    /**
     * Where money committed to a generation in flight is held.
     *
     * Shared in a real deployment, so instances see each other's. In memory by default, which is right
     * for one process and is all a test needs.
     */
    reservations?: Reservations;
    now?: () => Date;
}

export interface ResearchOutcome {
    saved: SavedBrief;
    cached: boolean;
    costUsdcMinor: bigint;
    issues: number;
    rejected: string[];
    /** How long generating it took. Absent when the brief was served from the cache. */
    timings?: { totalMs: number; docsMs: number; modelMs: number };
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
    /**
     * Money committed to generations that have not been stored yet.
     *
     * Spending is counted from the stored briefs, which is the durable record, but a generation in
     * flight has cost money and is not stored yet. Without this, two requests arriving together would
     * each see the same spent total and each believe there was room.
     */
    private readonly reservations: Reservations;

    constructor(private readonly deps: ResearchDeps) {
        this.now = deps.now ?? (() => new Date());
        this.reservations = deps.reservations ?? new MemoryReservations();
        if (deps.totalMaxSpendUsd < deps.maxSpendUsd) {
            throw new Error(
                `totalMaxSpendUsd (${deps.totalMaxSpendUsd}) must be at least maxSpendUsd (${deps.maxSpendUsd})`,
            );
        }
    }

    /**
     * What the agent has spent generating briefs, and what it may still spend.
     *
     * Counted from the briefs that were actually stored, plus what this instance has in flight. It used
     * to be a running total in a field, which is wrong wherever the process can be replaced between two
     * requests: every new instance started from zero, so a lifetime ceiling was really a per-instance
     * one with no bound on the number of instances. The briefs are the durable record of the spending,
     * and every instance reads the same ones.
     */
    async budget(): Promise<{ spentUsd: number; remainingUsd: number; spentUsdcMinor: bigint }> {
        const stored = await this.deps.briefs.totalCostUsdcMinor();
        const spentUsdcMinor = stored + (await this.reservations.outstanding());
        // display only; the comparison below is done in exact minor units
        const spentUsd = Number(spentUsdcMinor) / 1e6;
        return {
            spentUsd,
            spentUsdcMinor,
            remainingUsd: Math.max(0, this.deps.totalMaxSpendUsd - spentUsd),
        };
    }

    /** A brief for these themes that is young enough to serve, if one exists. */
    async findCached(themes: readonly ThemeSpec[]): Promise<SavedBrief | null> {
        // a zero window means no reuse at all; without this an age of exactly zero reads as fresh
        if (this.deps.maxAgeSeconds <= 0) return null;
        const key = themesKey(themes);
        const oldest = this.now().getTime() - this.deps.maxAgeSeconds * 1000;
        for (const saved of await this.deps.briefs.list()) {
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
        const cached = await this.findCached(themes);
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
        // Reserve first, then check, rather than the other way round. Checking first leaves a gap
        // between deciding there is room and taking it, and two instances arriving together both pass.
        // Taking the money first means a request that turns out not to fit gives it straight back, and
        // the worst case is a refusal that could have been allowed, which is the right way to be wrong
        // about spending.
        const reservation = usdToUsdcMinor(this.deps.maxSpendUsd);
        const held = await this.reservations.open(reservation);

        let spentUsd = 0;
        try {
            const stored = await this.deps.briefs.totalCostUsdcMinor();
            const ahead = await this.reservations.outstandingBefore(held);
            spentUsd = Number(stored + ahead + reservation) / 1e6;
        } catch (e) {
            await this.reservations.close(held);
            throw e;
        }

        // the reservation just taken is inside that total, so the comparison is against the cap itself
        if (spentUsd > this.deps.totalMaxSpendUsd) {
            await this.reservations.close(held);
            throw new Error(
                `research budget exhausted: $${(spentUsd - this.deps.maxSpendUsd).toFixed(4)} of ` +
                `$${this.deps.totalMaxSpendUsd} spent, which leaves less than the ` +
                `$${this.deps.maxSpendUsd} a brief may cost`,
            );
        }

        // Released whatever happens: a generation that threw must not hold the budget for ever. Once the
        // brief is stored, its real cost takes the reservation's place in the total.
        try {
            return await this.generateReserved(themes);
        } finally {
            await this.reservations.close(held);
        }
    }

    private async generateReserved(themes: readonly ThemeSpec[]): Promise<ResearchOutcome> {
        const companies = await this.deps.companies();
        const llm = budgetedLlm(
            this.deps.llm(),
            this.deps.maxSpendUsd,
            this.deps.priceInputPerMTokUsd,
            this.deps.priceOutputPerMTokUsd,
        );

        const startedAt = Date.now();
        const now = this.now();
        // A millisecond timestamp alone collides when two requests land in the same millisecond. That would
        // overwrite the earlier brief's file, destroying a buyer's brief and its audit trail, and would make
        // two briefs share the `llm-<briefId>` cost key so the second one's model cost is silently dropped
        // as a duplicate. The random suffix keeps ids unique while the timestamp keeps them sortable.
        const briefId = `brief-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
        const result = await researchBrief(
            {
                briefId, themes, companies, now, disclaimer: DISCLAIMER,
                preferred: new Set(BASE_REGISTRY.map((r) => r.address)),
            },
            { docs: this.deps.docs(), llm },
        );

        const costUsd = estimateCostUsd(result.usage, {
            inputPerMTokUsd: this.deps.priceInputPerMTokUsd,
            outputPerMTokUsd: this.deps.priceOutputPerMTokUsd,
        });
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

        // stored so a later request for the same themes can reuse it, and so the owner can audit it
        await this.deps.briefs.save(saved, {
            provider: saved.provider,
            model: saved.model,
            themesKey: saved.themesKey,
            themes,
            brief: saved.brief,
            issues: result.issues,
            rejected: result.rejected,
            reworded: result.reworded,
            usage: result.usage,
            costUsd,
            costUsdcMinor: costUsdcMinor.toString(),
        });

        // Logged on every generation, because this is the number that decides whether a buyer gets what
        // they paid for: the brief is produced inside their request, and a host that cuts the request off
        // at a fixed ceiling leaves them charged with nothing delivered.
        const docsMs = result.timings.reduce((t, x) => t + x.docsMs, 0);
        const modelMs = result.timings.reduce((t, x) => t + x.modelMs, 0);
        const totalMs = Date.now() - startedAt;
        log.info("brief_generated", `generated ${briefId} in ${totalMs} ms`, {
            briefId,
            totalMs,
            docsMs,
            modelMs,
            themes: result.timings.length,
            costUsd: Number(costUsd.toFixed(6)),
            costUsdcMinor: costUsdcMinor.toString(),
        });

        return {
            saved, cached: false, costUsdcMinor, issues: result.issues.length, rejected: result.rejected,
            timings: { totalMs, docsMs, modelMs },
        };
    }
}
