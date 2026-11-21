import { describe, it, expect } from "vitest";
import { parseUsdc as u } from "@surplus/core";
import { SwapExecutor, ExecutorRefused, openExecutor } from "../src/executor";

const KEY = "0x" + "77".repeat(32);
const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const config = (over: Partial<Parameters<typeof openExecutor>[0]> = {}) => ({
    rpcUrl: RPC,
    privateKey: KEY,
    usdc: USDC,
    spendCapUsdcMinor: u("20.00"),
    mainnetEnabled: true,
    slippageBps: 100,
    ...over,
});

describe("the executor refuses before it can lose money", () => {
    it("will not exist without mainnet explicitly enabled", () => {
        expect(() => new SwapExecutor(config({ mainnetEnabled: false }) as never))
            .toThrow(/MAINNET_ENABLED/);
    });

    it("will not exist without a spend cap", () => {
        expect(() => new SwapExecutor(config({ spendCapUsdcMinor: 0n }) as never))
            .toThrow(/positive spend cap/);
        expect(() => new SwapExecutor(config({ spendCapUsdcMinor: -1n }) as never))
            .toThrow(/positive spend cap/);
    });

    it("will not exist without a usable key", () => {
        expect(() => new SwapExecutor(config({ privateKey: "nope" }) as never))
            .toThrow(/32 byte hex private key/);
    });

    it("starts with its whole cap unspent", () => {
        const ex = new SwapExecutor(config() as never);
        expect(ex.budget()).toEqual({ spent: 0n, remaining: u("20.00") });
        expect(ex.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
});

describe("openExecutor explains itself rather than throwing", () => {
    it("declines quietly when mainnet is off, so the server can still start", () => {
        const r = openExecutor(config({ mainnetEnabled: false }));
        expect(r.executor).toBe(null);
        if (r.executor === null) expect(r.why).toMatch(/MAINNET_ENABLED/);
    });

    it("declines when there is no rpc or no key", () => {
        expect(openExecutor(config({ rpcUrl: "" })).executor).toBe(null);
        expect(openExecutor(config({ privateKey: "" })).executor).toBe(null);
    });

    it("opens when everything it needs is present and authorized", () => {
        const r = openExecutor(config());
        expect(r.executor).not.toBe(null);
    });

    it("declines when the cap is missing, rather than defaulting to one", () => {
        // a default cap would be a number nobody chose standing between the agent and real money
        const { spendCapUsdcMinor: _drop, ...rest } = config();
        const r = openExecutor(rest);
        expect(r.executor).toBe(null);
        if (r.executor === null) expect(r.why).toMatch(/spend cap/);
    });
});
