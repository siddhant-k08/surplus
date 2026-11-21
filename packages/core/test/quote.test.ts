import { describe, it, expect } from "vitest";
import {
    parseKyberRoute,
    priceOf,
    isQuoteFresh,
    minOut,
    routesUrl,
    fetchRoute,
    quoteLegs,
    KYBER_ROUTER_BASE,
    type Quote,
} from "../src/quote";
import { BASE_USDC } from "../src/liquidity";
import { NVDA, MSFT, META } from "./fixtures";

const ROUTER_MIXED = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const exp = { tokenIn: BASE_USDC, tokenOut: NVDA, amountIn: 1_000_000n };

// Shaped from the key names seen in the live response; the values are illustrative.
const response = (rs: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
    code: 0,
    message: "successfully",
    requestId: "req-1",
    data: {
        routerAddress: ROUTER_MIXED,
        routeSummary: {
            tokenIn: BASE_USDC.toUpperCase().replace("0X", "0x"),
            amountIn: "1000000",
            amountInUsd: "0.9999",
            tokenOut: NVDA,
            amountOut: "5000000000000000",
            amountOutUsd: "0.99",
            gas: "250000",
            gasPrice: "1000000",
            gasUsd: "0.0123",
            l1FeeUsd: "0.0007",
            extraFee: { feeAmount: "0" },
            route: [[]],
            routerAddress: ROUTER_MIXED,
            routeID: "route-abc",
            checksum: "123",
            timestamp: 1_795_000_000,
            ...rs,
        },
        ...data,
    },
});

describe("kyber route parsing", () => {
    it("parses a well-formed response and keeps routeSummary verbatim", () => {
        const body = response();
        const q = parseKyberRoute(body, exp);
        expect(q.tokenIn).toBe(BASE_USDC);
        expect(q.amountOut).toBe(5_000_000_000_000_000n);
        expect(q.amountOutUsd).toBe(0.99);
        expect(q.gasUsd).toBe(0.0123);
        expect(q.routerAddress).toBe(KYBER_ROUTER_BASE);
        expect(q.routeId).toBe("route-abc");
        expect(q.routeSummary).toBe(body.data.routeSummary);
    });

    it("accepts numeric amounts and converts millisecond timestamps to seconds", () => {
        const q = parseKyberRoute(response({ amountIn: 1_000_000, amountOut: 42, timestamp: 1_795_000_000_000 }), exp);
        expect(q.amountIn).toBe(1_000_000n);
        expect(q.amountOut).toBe(42n);
        expect(q.timestamp).toBe(1_795_000_000);
    });

    it("reports the API's code and message when there is no route", () => {
        expect(() => parseKyberRoute({ code: 4008, message: "route not found" }, exp)).toThrow(/4008.*route not found/);
        expect(() => parseKyberRoute(null, exp)).toThrow(/not an object/);
    });

    it("rejects a response that does not match the request", () => {
        expect(() => parseKyberRoute(response({ tokenOut: "0x" + "9".repeat(40) }), exp)).toThrow(/tokenOut/);
        expect(() => parseKyberRoute(response({ tokenIn: "0x" + "9".repeat(40) }), exp)).toThrow(/tokenIn/);
        expect(() => parseKyberRoute(response({ amountIn: "2000000" }), exp)).toThrow(/amountIn/);
        expect(() => parseKyberRoute(response({ amountOut: "0" }), exp)).toThrow(/amountOut/);
        expect(() => parseKyberRoute(response({ amountOut: "abc" }), exp)).toThrow(/amountOut/);
    });

    it("refuses an unexpected router", () => {
        const other = "0x" + "1".repeat(40);
        expect(() => parseKyberRoute(response({}, { routerAddress: other }), exp)).toThrow(/Unexpected router/);
        expect(() => parseKyberRoute(response({ routerAddress: other }), exp)).toThrow(/routeSummary/);
        expect(() => parseKyberRoute(response({}, { routerAddress: undefined }), exp)).toThrow(/missing/);
    });
});

describe("quote helpers", () => {
    const q = (over: Partial<Quote> = {}): Quote => ({
        ...parseKyberRoute(response(), exp),
        ...over,
    });

    it("priceOf gives USDC minor units per whole token", () => {
        // 1 USDC buys 0.005 tokens, so one token costs 200 USDC
        expect(priceOf(q(), 18)).toBe(200_000_000n);
    });

    it("isQuoteFresh respects the window and treats a missing timestamp as stale", () => {
        const at = (s: number) => new Date(s * 1000);
        expect(isQuoteFresh(q({ timestamp: 1000 }), at(1010))).toBe(true);
        expect(isQuoteFresh(q({ timestamp: 1000 }), at(1025))).toBe(true);
        expect(isQuoteFresh(q({ timestamp: 1000 }), at(1026))).toBe(false);
        expect(isQuoteFresh(q({ timestamp: 1000 }), at(990))).toBe(false);
        expect(isQuoteFresh(q({ timestamp: null }), at(1000))).toBe(false);
    });

    it("minOut rounds down and validates bps", () => {
        expect(minOut(1_000_000n, 100)).toBe(990_000n);
        expect(minOut(7n, 100)).toBe(6n);
        expect(minOut(5n, 0)).toBe(5n);
        expect(() => minOut(1n, 10_001)).toThrow();
        expect(() => minOut(1n, 0.5)).toThrow();
    });

    it("routesUrl builds the documented query", () => {
        const u = new URL(routesUrl({ tokenIn: BASE_USDC, tokenOut: NVDA, amountIn: 1_000_000n, slippageBps: 100 }));
        expect(u.origin + u.pathname).toBe("https://aggregator-api.kyberswap.com/base/api/v1/routes");
        expect(u.searchParams.get("amountIn")).toBe("1000000");
        expect(u.searchParams.get("slippageTolerance")).toBe("100");
        expect(u.searchParams.get("tokenOut")).toBe(NVDA);
    });
});

describe("fetching routes", () => {
    // Answers any route request with a well-formed response sized to the request.
    const routeFetch = (opts: { fail?: Record<string, unknown>; seen?: string[] } = {}) =>
        (async (url: string) => {
            opts.seen?.push(url);
            const u = new URL(url);
            const tokenOut = u.searchParams.get("tokenOut")!;
            const amountIn = u.searchParams.get("amountIn")!;
            const failure = opts.fail?.[tokenOut.toLowerCase()];
            const body = failure ?? response({ tokenOut, amountIn, amountOut: (BigInt(amountIn) * 5_000_000_000n).toString() });
            return { ok: failure === undefined, status: failure === undefined ? 200 : 404, json: async () => body };
        }) as unknown as typeof fetch;

    it("fetchRoute returns a parsed quote and surfaces the API's error message", async () => {
        const q = await fetchRoute({ tokenOut: NVDA, amountIn: 1_000_000n, slippageBps: 100 }, routeFetch());
        expect(q.amountOut).toBe(5_000_000_000_000_000n);

        const bad = routeFetch({ fail: { [NVDA]: { code: 4008, message: "route not found" } } });
        await expect(fetchRoute({ tokenOut: NVDA, amountIn: 1_000_000n, slippageBps: 100 }, bad)).rejects.toThrow(
            /4008.*route not found/,
        );

        const notJson = (async () => ({ ok: false, status: 502, json: async () => { throw new Error("x"); } })) as unknown as typeof fetch;
        await expect(fetchRoute({ tokenOut: NVDA, amountIn: 1_000_000n, slippageBps: 100 }, notJson)).rejects.toThrow(/HTTP 502/);
    });

    it("quoteLegs sums legs per token, spaces requests, and records failures without stopping", async () => {
        const seen: string[] = [];
        let sleeps = 0;
        const fetchImpl = routeFetch({ seen, fail: { [META]: { code: 4008, message: "route not found" } } });
        const legs = [
            { asset: NVDA, usdcIn: 300_000n },
            { asset: NVDA.toUpperCase().replace("0X", "0x"), usdcIn: 200_000n },
            { asset: META, usdcIn: 100_000n },
            { asset: MSFT, usdcIn: 100_000n },
        ];
        const decimals = new Map([[NVDA, 18], [META, 18]]); // MSFT deliberately missing
        const r = await quoteLegs(legs, decimals, {
            slippageBps: 100,
            fetchImpl,
            sleep: async () => { sleeps += 1; },
        });
        expect(seen).toHaveLength(2); // NVDA once (summed), META once; MSFT skipped
        expect(new URL(seen[0]!).searchParams.get("amountIn")).toBe("500000");
        expect(sleeps).toBe(1);
        expect(r.prices.get(NVDA)).toBe(200_000_000n);
        expect(r.errors.get(META)).toMatch(/route not found/);
        expect(r.errors.get(MSFT)).toBe("missing decimals");
        expect(r.prices.has(META)).toBe(false);
    });
});
describe("M6 regression: outbound requests carry a deadline", () => {
    it("passes an abort signal to the route request", async () => {
        let sawSignal = false;
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
            sawSignal = init?.signal instanceof AbortSignal;
            return new Response(JSON.stringify({ code: 1, message: "nope" }), { status: 200 });
        }) as unknown as typeof fetch;
        await fetchRoute({ tokenOut: "0x" + "b".repeat(40), amountIn: 1_000_000n, slippageBps: 100 }, fetchImpl)
            .catch(() => undefined);
        expect(sawSignal).toBe(true);
    });

    it("gives up instead of hanging when an upstream never answers", async () => {
        // a server that accepts and never responds used to hold the caller forever
        const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("TimeoutError")));
        })) as unknown as typeof fetch;
        await expect(fetchRoute(
            { tokenOut: "0x" + "b".repeat(40), amountIn: 1_000_000n, slippageBps: 100, timeoutMs: 20 },
            fetchImpl,
        )).rejects.toThrow();
    });
});
