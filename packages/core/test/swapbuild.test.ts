import { describe, it, expect } from "vitest";
import { buildSwap, parseBuiltSwap, KYBER_BUILD_URL } from "../src/swapbuild";
import { KYBER_ROUTER_BASE, type Quote } from "../src/quote";

const ROUTER = KYBER_ROUTER_BASE;
const quote: Quote = {
    tokenIn: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tokenOut: "0xb20000000000000000000078ee7ce2fe4908108c",
    amountIn: 1_000_000n,
    amountOut: 10_000_000_000_000_000n,
    amountInUsd: 1, amountOutUsd: 1, gasUsd: 0.003, l1FeeUsd: null,
    routerAddress: ROUTER, routeId: "r1", timestamp: 1,
    routeSummary: { opaque: "from the quote" },
};

const good = (over: Record<string, unknown> = {}) => ({
    data: {
        data: "0xdeadbeefdeadbeef",
        routerAddress: ROUTER,
        amountIn: "1000000",
        amountOut: "10000000000000000",
        gas: "210000",
        ...over,
    },
});

const expectArgs = { amountIn: 1_000_000n, minOut: 9_900_000_000_000_000n };

describe("parseBuiltSwap", () => {
    it("accepts an encoded route that matches what was quoted", () => {
        const built = parseBuiltSwap(good(), expectArgs);
        expect(built.data).toBe("0xdeadbeefdeadbeef");
        expect(built.router).toBe(ROUTER.toLowerCase());
        expect(built.amountIn).toBe(1_000_000n);
        expect(built.gas).toBe(210_000n);
        expect(built.minOut).toBe(expectArgs.minOut);
    });

    it("refuses a router other than the pinned one", () => {
        expect(() => parseBuiltSwap(good({ routerAddress: "0x" + "9".repeat(40) }), expectArgs))
            .toThrow(/expected/);
        expect(() => parseBuiltSwap(good({ routerAddress: undefined }), expectArgs)).toThrow(/missing/);
    });

    it("refuses to spend more than was quoted and approved", () => {
        // the single most dangerous drift: calldata that moves more money than the owner agreed to
        expect(() => parseBuiltSwap(good({ amountIn: "2000000" }), expectArgs))
            .toThrow(/would spend 2000000, but 1000000 was quoted/);
    });

    it("refuses an encoded route whose output is below the agreed floor", () => {
        expect(() => parseBuiltSwap(good({ amountOut: "1" }), expectArgs))
            .toThrow(/below the agreed floor/);
    });

    it("refuses missing or malformed calldata", () => {
        expect(() => parseBuiltSwap(good({ data: "" }), expectArgs)).toThrow(/no usable calldata/);
        expect(() => parseBuiltSwap(good({ data: "not hex" }), expectArgs)).toThrow(/no usable calldata/);
        expect(() => parseBuiltSwap(good({ data: "0x12" }), expectArgs)).toThrow(/no usable calldata/);
        expect(() => parseBuiltSwap({}, expectArgs)).toThrow();
    });
});

describe("buildSwap", () => {
    it("posts the route summary back untouched, with the owner's slippage and a deadline", async () => {
        let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            seen = {
                url: String(url),
                body: JSON.parse(String(init?.body)),
                headers: init?.headers as Record<string, string>,
            };
            return new Response(JSON.stringify(good()), { status: 200 });
        }) as unknown as typeof fetch;

        const built = await buildSwap({
            quote, sender: "0xsender", recipient: "0xrecipient",
            slippageBps: 100, minOut: expectArgs.minOut,
            now: () => 1_700_000_000_000, fetchImpl,
        });

        expect(built.amountIn).toBe(1_000_000n);
        expect(seen!.url).toBe(KYBER_BUILD_URL);
        expect(seen!.body.routeSummary).toEqual({ opaque: "from the quote" });
        expect(seen!.body.slippageTolerance).toBe(100);
        expect(seen!.body.deadline).toBe(1_700_000_000 + 120);
        expect(seen!.headers["x-client-id"]).toBe("surplus-hackathon");
    });

    it("surfaces the encoder's own refusal", async () => {
        const fetchImpl = (async () =>
            new Response(JSON.stringify({ message: "route expired" }), { status: 400 })) as unknown as typeof fetch;
        await expect(
            buildSwap({ quote, sender: "0xs", recipient: "0xr", slippageBps: 100, minOut: 1n, fetchImpl }),
        ).rejects.toThrow(/route expired/);
    });

    it("carries a deadline so a stalled transaction cannot land much later", async () => {
        const fetchImpl = (async (_u: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            return new Response(JSON.stringify(good()), { status: 200 });
        }) as unknown as typeof fetch;
        await buildSwap({ quote, sender: "0xs", recipient: "0xr", slippageBps: 100, minOut: expectArgs.minOut, fetchImpl });
    });
});
