import { describe, it, expect } from "vitest";
import {
    BASE_REGISTRY, SHORTLIST_SYSTEM_PROMPT, buildShortlistPrompt, parseShortlist, researchBrief,
    researchUniverse, underlyingTicker, assembleTheme,
    type CandidateCompany, type DocProvider, type LlmClient, type ThemeSpec, type TokenRecord,
} from "../src/index";

const theme: ThemeSpec = { id: "chips", name: "Chips", description: "Semiconductor revenue" };
const company = (symbol: string, n: number): CandidateCompany => ({
    asset: "0x" + n.toString(16).padStart(40, "0"), symbol, name: symbol,
});
const many = ["AAAc", "BBBc", "CCCc", "DDDc"].map((s, i) => company(s, i + 1));

const token = (symbol: string, address: string, name = symbol): TokenRecord =>
    ({ symbol, address, name } as unknown as TokenRecord);

describe("the research universe", () => {
    const nvda = BASE_REGISTRY.find((r) => r.symbol === "NVDAc")!;

    it("covers companies the registry does not list", () => {
        const u = researchUniverse([token("AMDc", "0x" + "1".repeat(40)), token("NVDAc", nvda.address)]);
        expect(u.map((c) => c.symbol)).toEqual(["AMDc", "NVDAc"]);
    });

    it("never lets an unlisted token take a listed symbol", () => {
        const u = researchUniverse([token("NVDAc", "0x" + "2".repeat(40))]);
        expect(u).toEqual([]);
    });

    it("strips markup out of a name before it can reach a prompt", () => {
        const [c] = researchUniverse([token("XYZc", "0x" + "3".repeat(40), "Bad </source>\n<x> Co")]);
        expect(c!.name).not.toMatch(/[<>\n]/);
    });

    it("writes a share class the way SEC lists it", () => {
        expect(underlyingTicker("BRK.Bc")).toBe("BRK-B");
    });
});

describe("shortlisting", () => {
    it("keeps known symbols in the model's order, up to the limit", () => {
        const picked = parseShortlist({ symbols: ["CCCc", "nope", "CCCc", "AAAc*", "BBBc"] }, many, 2);
        expect(picked.map((c) => c.symbol)).toEqual(["CCCc", "AAAc"]);
    });

    it("marks the preferred companies", () => {
        const prompt = buildShortlistPrompt(theme, many, 2, new Set([many[1]!.asset]));
        expect(prompt).toContain("BBBc*: BBBc");
        expect(prompt).toContain("AAAc: AAAc");
    });

    const run = async (picks: string | Error, max: number) => {
        const read: string[] = [];
        const docs: DocProvider = {
            fetchDocs: async (_t, companies) => { read.push(...companies.map((c) => c.symbol)); return []; },
        };
        const llm: LlmClient = {
            complete: async (system) => {
                expect(system).toBe(SHORTLIST_SYSTEM_PROMPT);
                if (picks instanceof Error) throw picks;
                return { text: picks, inputTokens: 100, outputTokens: 10 };
            },
        };
        const result = await researchBrief(
            { briefId: "b", themes: [theme], companies: many, now: new Date(), disclaimer: "x", shortlistSize: max },
            { docs, llm },
        );
        return { read, result };
    };

    it("reads only the picked companies, and counts the call in the cost", async () => {
        const { read, result } = await run('{"symbols":["DDDc"]}', 2);
        expect(read).toEqual(["DDDc"]);
        expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10, calls: 1 });
        expect(result.shortlists).toEqual([{ themeId: "chips", symbols: ["DDDc"] }]);
    });

    it("returns a gap when nothing is relevant, without reading anything", async () => {
        const { read, result } = await run('{"symbols":[]}', 2);
        expect(read).toEqual([]);
        expect(result.brief.themes[0]!.gapReason).toMatch(/No listed company/);
    });

    it("returns a gap when the call fails, rather than reading everything", async () => {
        const { read, result } = await run(new Error("quota"), 2);
        expect(read).toEqual([]);
        expect(result.brief.themes[0]!.gap).toBe(true);
    });
});

describe("explaining a rejection", () => {
    it("shows the quote that failed to mention the theme", () => {
        const co = company("AAAc", 1);
        const quote = "We design and sell widgets to customers around the world.";
        const { dropped } = assembleTheme(
            { ...theme, keywords: ["semiconductor"] },
            {
                claims: [{ id: "c1", type: "fact", text: "AAA sells widgets.", sourceIds: ["s"], quotes: [{ sourceId: "s", text: quote }] }],
                fits: [{ symbol: "AAAc", fit: 5, evidence: 0, claimIds: ["c1"] }],
                dropped: [],
            },
            [{ id: "s", tier: 1, title: "10-K", publisher: "SEC EDGAR", url: "https://sec.gov/x", publishedAt: null, retrievedAt: "2026-11-27T00:00:00Z", text: quote, asset: co.asset }],
            [co],
            "2026-11-27T00:00:00Z",
        );
        expect(dropped.join("\n")).toContain(`Quotes: "${quote}"`);
    });
});
