import { describe, it, expect } from "vitest";
import { loadConfig, BASE_SEPOLIA, BASE_MAINNET, USDC } from "../src/config";

const PAY_TO = "0x" + "a".repeat(40);
const base = { X402_PAY_TO: PAY_TO } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
    it("defaults to Base Sepolia with the free facilitator and tags the ledger testnet", () => {
        const c = loadConfig(base);
        expect(c.network).toBe(BASE_SEPOLIA);
        expect(c.facilitatorUrl).toBe("https://x402.org/facilitator");
        expect(c.mode).toBe("testnet");
        expect(c.expectedAsset).toBe(USDC[BASE_SEPOLIA]);
        expect(c.port).toBe(4021);
    });

    it("refuses mainnet unless it is explicitly authorized", () => {
        expect(() => loadConfig({ ...base, X402_NETWORK: BASE_MAINNET })).toThrow(/MAINNET_ENABLED/);
        const c = loadConfig({ ...base, X402_NETWORK: BASE_MAINNET, MAINNET_ENABLED: "true" });
        expect(c.mode).toBe("mainnet");
        expect(c.expectedAsset).toBe(USDC[BASE_MAINNET]);
    });

    it("refuses a network it does not know rather than defaulting", () => {
        expect(() => loadConfig({ ...base, X402_NETWORK: "eip155:1" })).toThrow(/X402_NETWORK/);
        expect(() => loadConfig({ ...base, X402_NETWORK: "base-sepolia" })).toThrow(/X402_NETWORK/);
    });

    it("requires a payTo address and rejects a malformed one", () => {
        expect(() => loadConfig({})).toThrow(/X402_PAY_TO/);
        expect(() => loadConfig({ X402_PAY_TO: "0xnope" })).toThrow(/20 byte hex/);
    });

    it("rejects a price that is not a plain dollar amount", () => {
        expect(() => loadConfig({ ...base, BRIEF_PRICE_USD: "3.00" })).toThrow(/BRIEF_PRICE_USD/);
        expect(() => loadConfig({ ...base, BRIEF_PRICE_USD: "$free" })).toThrow(/BRIEF_PRICE_USD/);
        expect(loadConfig({ ...base, BRIEF_PRICE_USD: "$0.01" }).priceUsd).toBe("$0.01");
    });

    it("rejects an invalid port", () => {
        expect(() => loadConfig({ ...base, PORT: "0" })).toThrow(/PORT/);
        expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
    });
});
