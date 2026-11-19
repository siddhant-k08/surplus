import { describe, it, expect } from "vitest";
import {
    parsePairs,
    usdcPools,
    liquidityScore,
    liquidityScores,
    fetchTokenPairs,
    loadLiquidityScores,
    BASE_USDC,
} from "../src/liquidity";
import { toCandidates } from "../src/research";
import { addr, NVDA, MSFT } from "./fixtures";

const pair = (over: Record<string, unknown> = {}) => ({
    chainId: "base",
    dexId: "aerodrome",
    pairAddress: "0xpool1",
    labels: ["CL"],
    baseToken: { address: NVDA.toUpperCase().replace("0X", "0x"), symbol: "NVDAc" },
    quoteToken: { address: BASE_USDC, symbol: "USDC" },
    priceUsd: "152.5",
    liquidity: { usd: 800000 },
    volume: { h24: 12345 },
    ...over,
});

describe("liquidity", () => {
    it("parses pairs, lowercases addresses and keeps only Base", () => {
        const pairs = parsePairs([pair(), pair({ chainId: "ethereum" }), pair({ pairAddress: "" }), null]);
        expect(pairs).toHaveLength(1);
        expect(pairs[0]!.base).toBe(NVDA);
        expect(pairs[0]!.priceUsd).toBe(152.5);
        expect(pairs[0]!.liquidityUsd).toBe(800000);
    });

    it("accepts a { pairs: [] } wrapper and rejects other shapes", () => {
        expect(parsePairs({ pairs: [pair()] })).toHaveLength(1);
        expect(() => parsePairs({ nope: 1 })).toThrow(/not an array/);
    });

    it("treats missing liquidity as zero", () => {
        expect(parsePairs([pair({ liquidity: undefined })])[0]!.liquidityUsd).toBe(0);
    });

    it("usdcPools matches exact addresses only and sorts by liquidity", () => {
        const fake = pair({
            pairAddress: "0xfake",
            baseToken: { address: addr("f"), symbol: "NVDAc" }, // lookalike symbol, wrong address
            liquidity: { usd: 9_000_000 },
        });
        const small = pair({ pairAddress: "0xpool2", liquidity: { usd: 50_000 } });
        const pools = usdcPools(parsePairs([small, fake, pair()]), NVDA);
        expect(pools.map((p) => p.pairAddress)).toEqual(["0xpool1", "0xpool2"]);
    });

    it("only reports a token price when the token is the base side", () => {
        const flipped = pair({
            baseToken: { address: BASE_USDC, symbol: "USDC" },
            quoteToken: { address: NVDA, symbol: "NVDAc" },
        });
        expect(usdcPools(parsePairs([flipped]), NVDA)[0]!.tokenPriceUsd).toBeNull();
        expect(usdcPools(parsePairs([pair()]), NVDA)[0]!.tokenPriceUsd).toBe(152.5);
    });

    it("liquidityScore follows the thresholds", () => {
        expect(
            [0, 24_999, 25_000, 99_999, 100_000, 249_999, 250_000, 499_999, 500_000, 999_999, 1_000_000].map(liquidityScore),
        ).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
        expect(liquidityScore(NaN)).toBe(0);
        expect(liquidityScore(-5)).toBe(0);
    });

    it("liquidityScores uses the deepest pool and scores a token with no pool as 0", () => {
        const pairs = parsePairs([pair({ liquidity: { usd: 300_000 } }), pair({ pairAddress: "0xpool2", liquidity: { usd: 600_000 } })]);
        const m = liquidityScores(pairs, [NVDA, MSFT]);
        expect(m.get(NVDA)).toBe(4);
        expect(m.get(MSFT)).toBe(0);
    });

    it("feeds toCandidates", () => {
        const m = liquidityScores(parsePairs([pair({ liquidity: { usd: 2_000_000 } })]), [NVDA]);
        const c = toCandidates([{ asset: NVDA, symbol: "NVDAc", fit: 4, evidence: 4, claimIds: [] }], m);
        // 0.5*4 + 0.2*4 + 0.3*5 = 4.3 -> 430
        expect(c[0]!.weight).toBe(430);
    });

    it("fetchTokenPairs requests the lowercase per-token URL and throws on a non-OK response", async () => {
        const urls: string[] = [];
        const ok = (async (url: string) => {
            urls.push(url);
            return { ok: true, status: 200, json: async () => [] };
        }) as unknown as typeof fetch;
        await fetchTokenPairs(NVDA.toUpperCase().replace("0X", "0x"), ok);
        expect(urls[0]).toBe(`https://api.dexscreener.com/token-pairs/v1/base/${NVDA}`);

        const bad = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
        await expect(fetchTokenPairs(NVDA, bad)).rejects.toThrow(/HTTP 429/);
    });

    it("loadLiquidityScores makes one spaced request per token and scores the deepest pool", async () => {
        const msftPair = (usd: number, id: string) =>
            pair({ pairAddress: id, baseToken: { address: MSFT, symbol: "MSFTc" }, liquidity: { usd } });
        const byToken: Record<string, unknown[]> = {
            [NVDA]: [pair({ liquidity: { usd: 300_000 } }), pair({ pairAddress: "0xp2", liquidity: { usd: 1_200_000 } })],
            [MSFT]: [msftPair(30_000, "0xm1"), msftPair(40_000, "0xm2")],
        };
        const requested: string[] = [];
        const fake = (async (url: string) => {
            const token = url.split("/").pop()!;
            requested.push(token);
            return { ok: true, status: 200, json: async () => byToken[token] ?? [] };
        }) as unknown as typeof fetch;
        let sleeps = 0;
        const { scores, pairs } = await loadLiquidityScores([NVDA, MSFT, addr("9")], {
            fetchImpl: fake,
            sleep: async () => { sleeps += 1; },
        });
        expect(requested).toEqual([NVDA, MSFT, addr("9")]);
        expect(sleeps).toBe(2);
        expect(pairs).toHaveLength(4);
        expect(scores.get(NVDA)).toBe(5);
        expect(scores.get(MSFT)).toBe(1);
        expect(scores.get(addr("9"))).toBe(0);
    });
});