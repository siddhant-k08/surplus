import { describe, it, expect } from "vitest";
import { validateBrief, toCandidates, type Brief, type Fit } from "../src/research";
import { NVDA, MSFT, TSLA } from "./fixtures";

const ctx = { eligible: new Set([NVDA, MSFT]) };

const goodBrief = (): Brief => ({
    id: "brief-1",
    createdAt: "2026-11-18T12:00:00Z",
    sources: [
        { id: "S1", tier: 1, title: "Quarterly filing", publisher: "SEC", url: "https://example.com/10q", publishedAt: "2026-10-30", retrievedAt: "2026-11-18T11:00:00Z", excerpt: "data center revenue" },
        { id: "S2", tier: 2, title: "Earnings release", publisher: "Company IR", url: "https://example.com/ir", publishedAt: "2026-10-29", retrievedAt: "2026-11-18T11:05:00Z", excerpt: "cloud capex" },
        { id: "S3", tier: 4, title: "News A", publisher: "Wire A", url: "https://example.com/a", publishedAt: null, retrievedAt: "2026-11-18T11:10:00Z", excerpt: "report" },
        { id: "S4", tier: 4, title: "News B", publisher: "Wire B", url: "https://example.com/b", publishedAt: null, retrievedAt: "2026-11-18T11:11:00Z", excerpt: "report" },
        { id: "S5", tier: 5, title: "Blog", publisher: "Blogger", url: "https://example.com/blog", publishedAt: null, retrievedAt: "2026-11-18T11:12:00Z", excerpt: "take" },
    ],
    themes: [
        {
            themeId: "ai-compute",
            claims: [
                { id: "c1", type: "fact", text: "Data center segment is the largest.", sourceIds: ["S1"] },
                { id: "c2", type: "fact", text: "Cloud capex rose.", sourceIds: ["S2"] },
                { id: "c3", type: "assumption", text: "Eligibility per token list.", sourceIds: [], asOf: "2026-11-18" },
                { id: "c4", type: "opinion", text: "MSFT looks more diversified.", sourceIds: [], confidence: "low" },
            ],
            fits: [
                { asset: NVDA, symbol: "NVDAc", fit: 4, evidence: 4, claimIds: ["c1"] },
                { asset: MSFT, symbol: "MSFTc", fit: 4, evidence: 3, claimIds: ["c2", "c4"] },
            ],
            gap: false,
        },
        { themeId: "longevity-biotech", claims: [], fits: [], gap: true, gapReason: "No eligible tokenized stock matches." },
    ],
    disclaimer: "Informational research, not personalized investment advice.",
});

const rules = (b: Brief) => validateBrief(b, ctx).map((i) => i.rule);
const edit = (fn: (b: Brief) => void): Brief => {
    const b = structuredClone(goodBrief());
    fn(b);
    return b;
};

describe("research validation", () => {
    it("accepts a well-formed brief", () => {
        expect(validateBrief(goodBrief(), ctx)).toEqual([]);
    });

    it("flags a claim that cites an unknown source", () => {
        expect(rules(edit((b) => (b.themes[0]!.claims[0]!.sourceIds = ["S9"])))).toContain("sourceResolves");
    });

    it("rejects a fact backed only by a tier 5 source", () => {
        expect(rules(edit((b) => (b.themes[0]!.claims[0]!.sourceIds = ["S5"])))).toContain("factEvidence");
    });

    it("needs two independent tier 4 sources for a fact without a stronger source", () => {
        expect(rules(edit((b) => (b.themes[0]!.claims[0]!.sourceIds = ["S3"])))).toContain("factEvidence");
        expect(rules(edit((b) => (b.themes[0]!.claims[0]!.sourceIds = ["S3", "S4"])))).not.toContain("factEvidence");
    });

    it("requires a date on assumptions and a confidence label on opinions", () => {
        expect(rules(edit((b) => delete b.themes[0]!.claims[2]!.asOf))).toContain("assumptionDate");
        expect(rules(edit((b) => delete b.themes[0]!.claims[3]!.confidence))).toContain("opinionConfidence");
    });

    it("checks fits: eligible asset, fact citation, score range, resolvable claims", () => {
        expect(rules(edit((b) => (b.themes[0]!.fits[0]!.asset = TSLA)))).toContain("eligible");
        expect(rules(edit((b) => (b.themes[0]!.fits[1]!.claimIds = ["c4"])))).toContain("fitNeedsFact");
        expect(rules(edit((b) => (b.themes[0]!.fits[0]!.fit = 7)))).toContain("scoreRange");
        expect(rules(edit((b) => (b.themes[0]!.fits[0]!.claimIds = ["c1", "zzz"])))).toContain("claimResolves");
    });

    it("requires a reason for gaps and fits for non-gap themes", () => {
        expect(rules(edit((b) => (b.themes[1]!.gapReason = " ")))).toContain("gapReason");
        expect(rules(edit((b) => b.themes[1]!.fits.push(b.themes[0]!.fits[0]!)))).toContain("gapHasFits");
        expect(rules(edit((b) => (b.themes[1]!.gap = false)))).toContain("themeEmpty");
    });

    it("checks source hygiene: duplicate ids, https URLs, dates, excerpts", () => {
        expect(rules(edit((b) => (b.sources[1]!.id = "S1")))).toContain("uniqueId");
        expect(rules(edit((b) => (b.sources[0]!.url = "http://example.com")))).toContain("url");
        expect(rules(edit((b) => (b.sources[0]!.retrievedAt = "yesterday")))).toContain("retrievedAt");
        expect(rules(edit((b) => (b.sources[0]!.excerpt = "")))).toContain("excerpt");
    });

    it("requires a disclaimer", () => {
        expect(rules(edit((b) => (b.disclaimer = "")))).toContain("disclaimer");
    });
});

describe("toCandidates", () => {
    const fits: Fit[] = [
        { asset: NVDA, symbol: "NVDAc", fit: 5, evidence: 4, claimIds: [] },
        { asset: MSFT, symbol: "MSFTc", fit: 2, evidence: 5, claimIds: [] },
        { asset: TSLA, symbol: "TSLAc", fit: 3, evidence: 3, claimIds: [] },
    ];

    it("drops fits below the floor and weights the rest by rank", () => {
        const liq = new Map([[NVDA, 4], [TSLA, 2]]);
        const c = toCandidates(fits, liq);
        expect(c.map((x) => x.symbol)).toEqual(["NVDAc", "TSLAc"]);
        // NVDA: 0.5*5 + 0.2*4 + 0.3*4 = 4.5 -> 450 ; TSLA: 1.5 + 0.6 + 0.6 = 2.7 -> 270
        expect(c.map((x) => x.weight)).toEqual([450, 270]);
    });

    it("drops tokens below the minimum liquidity score", () => {
        const liq = new Map([[NVDA, 4], [TSLA, 0]]);
        const all = [fits[0]!, fits[2]!];
        expect(toCandidates(all, liq).map((x) => x.symbol)).toEqual(["NVDAc", "TSLAc"]);
        expect(toCandidates(all, liq, 3, 1).map((x) => x.symbol)).toEqual(["NVDAc"]);
        expect(toCandidates(all, new Map(), 3, 1)).toEqual([]);
    });

    it("treats missing liquidity as zero and clamps to the 0 to 5 range", () => {
        const c = toCandidates([fits[0]!], new Map([[NVDA, 99]]));
        expect(c[0]!.weight).toBe(Math.round((0.5 * 5 + 0.2 * 4 + 0.3 * 5) * 100));
        expect(toCandidates([fits[0]!], new Map())[0]!.weight).toBe(Math.round((2.5 + 0.8) * 100));
    });
});