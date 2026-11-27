import { describe, it, expect } from "vitest";
import {
    CHECK_SYSTEM_PROMPT, applyCheck, checkItems, researchBrief,
    type DocProvider, type LlmClient, type ParsedTheme, type SourceDoc, type ThemeSpec,
} from "../src/index";

const asset = "0x" + "1".repeat(40);
const quote = "We design and sell widgets to customers around the world.";
const doc: SourceDoc = {
    id: "s", tier: 1, title: "10-K", publisher: "SEC EDGAR", url: "https://sec.gov/x",
    publishedAt: null, retrievedAt: "2026-11-27T00:00:00Z", text: quote, asset,
};
const fact = (id: string, text: string, q = quote) =>
    ({ id, type: "fact" as const, text, sourceIds: ["s"], quotes: [{ sourceId: "s", text: q }] });
const parsed = (...claims: ParsedTheme["claims"]): ParsedTheme => ({ claims, fits: [], dropped: [] });

describe("the quote check", () => {
    it("sends only facts whose quote is really in the document", () => {
        const items = checkItems(parsed(fact("c1", "A."), fact("c2", "B.", "A sentence that is nowhere in it.")), [doc]);
        expect(items.map((i) => i.id)).toEqual(["c1"]);
    });

    it("takes the shorter sentence and keeps a record of the change", () => {
        const p = parsed(fact("c1", "Acme sells widgets to governments."));
        const r = applyCheck(p, checkItems(p, [doc]), { facts: [{ id: "c1", text: "Acme sells widgets." }] });
        expect(r.parsed.claims[0]!.text).toBe("Acme sells widgets.");
        expect(r.reworded[0]).toContain("governments");
    });

    it("drops a fact that is rejected or not answered", () => {
        const p = parsed(fact("c1", "A."), fact("c2", "B."));
        const r = applyCheck(p, checkItems(p, [doc]), { facts: [{ id: "c1", text: "" }] });
        expect(r.parsed.claims).toEqual([]);
        expect(r.parsed.dropped).toHaveLength(2);
    });

    const theme: ThemeSpec = { id: "w", name: "Widgets", description: "Widget revenue" };
    const run = async (check: string) => {
        const docs: DocProvider = { fetchDocs: async () => [doc] };
        let seen = "";
        const llm: LlmClient = {
            complete: async (system, user) => {
                if (system === CHECK_SYSTEM_PROMPT) seen = user;
                return {
                    text: system === CHECK_SYSTEM_PROMPT ? check : JSON.stringify({
                        claims: [fact("c1", "Acme sells 40 widgets to governments.")],
                        fits: [{ symbol: "ACMEc", fit: 5, claimIds: ["c1"] }],
                    }),
                    inputTokens: 10, outputTokens: 10,
                };
            },
        };
        const result = await researchBrief(
            { briefId: "b", themes: [theme], companies: [{ asset, symbol: "ACMEc", name: "Acme" }], now: new Date(), disclaimer: "x" },
            { docs, llm },
        );
        return { result, seen };
    };

    it("publishes what the check returned, having shown it only the sentence and quotes", async () => {
        const { result, seen } = await run('{"facts":[{"id":"c1","text":"Acme sells widgets."}]}');
        expect(result.brief.themes[0]!.claims[0]!.text).toBe("Acme sells widgets.");
        expect(result.usage.calls).toBe(2);
        expect(JSON.parse(seen).items[0]).toEqual({ id: "c1", text: "Acme sells 40 widgets to governments.", quotes: [quote] });
    });

    it("still applies the number rule to the rewritten sentence", async () => {
        const { result } = await run('{"facts":[{"id":"c1","text":"Acme sells 7 widgets."}]}');
        expect(result.brief.themes[0]!.gap).toBe(true);
    });

    it("publishes nothing unchecked when the check cannot be read", async () => {
        const { result } = await run("no");
        expect(result.brief.themes[0]!.gap).toBe(true);
        expect(result.brief.themes[0]!.claims).toEqual([]);
    });
});
