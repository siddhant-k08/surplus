import { describe, it, expect } from "vitest";
import {
    parseTokenPage,
    loadAllTokens,
    fetchTokenPage,
    navStatus,
    tradability,
    type TokenRecord,
} from "../src/tokens";

const ADDR_A = "0x" + "A".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

const raw = (over: Record<string, unknown> = {}) => ({
    contract_address: ADDR_A,
    symbol: "NVDAc",
    name: "NVIDIA",
    decimals: 18,
    multiplier: 1,
    nav_price: 190.5,
    nav_price_updated_at: "2026-11-18T14:30:00Z",
    ...over,
});

const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
    address: ADDR_B,
    symbol: "MSFTc",
    name: "Microsoft",
    decimals: 18,
    isin: null,
    multiplier: 1,
    pausedFeatures: [],
    navPrice: 400,
    navUpdatedAt: "2026-11-18T14:30:00.000Z",
    totalSupply: null,
    ...over,
});

describe("tokens", () => {
    it("parses a page, lowercases addresses and turns omitted fields into null or empty", () => {
        const page = parseTokenPage({ tokens: [raw()] });
        expect(page.next).toBeNull();
        expect(page.rejected).toEqual([]);
        const t = page.tokens[0]!;
        expect(t.address).toBe(ADDR_A.toLowerCase());
        expect(t.isin).toBeNull();
        expect(t.pausedFeatures).toEqual([]);
        expect(t.totalSupply).toBeNull();
        expect(t.navUpdatedAt).toBe("2026-11-18T14:30:00.000Z");
    });

    it("reports bad records as rejected instead of keeping or throwing", () => {
        const page = parseTokenPage({
            tokens: [raw({ contract_address: "0x123" }), raw({ symbol: "" }), raw({ decimals: undefined }), raw()],
        });
        expect(page.tokens).toHaveLength(1);
        expect(page.rejected.map((r) => r.index)).toEqual([0, 1, 2]);
    });

    it("treats a missing or non-positive NAV price as no price", () => {
        expect(parseTokenPage({ tokens: [raw({ nav_price: undefined })] }).tokens[0]!.navPrice).toBeNull();
        expect(parseTokenPage({ tokens: [raw({ nav_price: 0 })] }).tokens[0]!.navPrice).toBeNull();
    });

    it("throws when the response shape is wrong", () => {
        expect(() => parseTokenPage(null)).toThrow(/not an object/);
        expect(() => parseTokenPage({ tokens: "nope" })).toThrow(/tokens/);
    });

    it("loadAllTokens follows next_page_token and dedupes by address", async () => {
        const calls: (string | undefined)[] = [];
        const pages: Record<string, unknown> = {
            first: { tokens: [raw()], next_page_token: "p2" },
            p2: { tokens: [raw({ contract_address: ADDR_B, symbol: "MSFTc" }), raw()] },
        };
        const res = await loadAllTokens(async (t) => {
            calls.push(t);
            return pages[t ?? "first"];
        });
        expect(calls).toEqual([undefined, "p2"]);
        expect(res.pages).toBe(2);
        expect(res.tokens.map((t) => t.symbol).sort()).toEqual(["MSFTc", "NVDAc"]);
    });

    it("loadAllTokens aborts when a page token repeats", async () => {
        await expect(
            loadAllTokens(async () => ({ tokens: [raw()], next_page_token: "same" })),
        ).rejects.toThrow(/repeated/);
    });

    it("fetchTokenPage builds the URL and throws on a non-OK response", async () => {
        const urls: string[] = [];
        const ok = (async (url: string) => {
            urls.push(url);
            return { ok: true, status: 200, json: async () => ({ tokens: [] }), text: async () => "" };
        }) as unknown as typeof fetch;
        await fetchTokenPage("abc", ok);
        expect(urls[0]).toBe("https://api.coinbase.com/v1/tokenized-stocks?page_size=500&page_token=abc");

        const bad = (async () => ({
            ok: false,
            status: 503,
            json: async () => ({}),
            text: async () => "unavailable",
        })) as unknown as typeof fetch;
        await expect(fetchTokenPage(undefined, bad)).rejects.toThrow(/HTTP 503/);
    });

    it("navStatus reports fresh, stale and missing", () => {
        const now = new Date("2026-11-18T14:35:00Z");
        expect(navStatus(record(), now, 600)).toBe("fresh");
        expect(navStatus(record(), now, 60)).toBe("stale");
        expect(navStatus(record({ navPrice: null }), now, 600)).toBe("missing");
        expect(navStatus(record({ navUpdatedAt: null }), now, 600)).toBe("missing");
    });

    it("tradability blocks paused features and a missing multiplier", () => {
        expect(tradability(record())).toEqual({ ok: true, reasons: [] });
        expect(tradability(record({ pausedFeatures: [2] })).ok).toBe(false);
        expect(tradability(record({ multiplier: null })).reasons[0]).toMatch(/multiplier/);
    });
});