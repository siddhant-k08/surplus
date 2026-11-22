import { describe, it, expect } from "vitest";
import { loadConfig, BASE_SEPOLIA, BASE_MAINNET, USDC } from "../src/config";

const PAY_TO = "0x" + "a".repeat(40);
const base = { X402_PAY_TO: PAY_TO, OWNER_TOKEN: "owner-token-for-tests-only", OWNER_ADDRESS: "0x" + "9".repeat(40) } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
    it("defaults to Base Sepolia with the free facilitator and tags the ledger testnet", () => {
        const c = loadConfig(base);
        expect(c.network).toBe(BASE_SEPOLIA);
        expect(c.facilitatorUrl).toBe("https://x402.org/facilitator");
        expect(c.mode).toBe("testnet");
        expect(c.expectedAsset).toBe(USDC[BASE_SEPOLIA]);
        expect(c.port).toBe(4021);
        expect(c.priceUsd).toBe("$0.01"); // small on purpose: a demo buyer should not need much test USDC
    });

    it("gives up on the facilitator long before its own 90 second default", () => {
        // 90s is the client's default and the wrong order of magnitude for someone waiting on a page
        expect(loadConfig(base).facilitatorTimeoutMs).toBe(15000);
        expect(loadConfig({ ...base, FACILITATOR_TIMEOUT_MS: "8000" }).facilitatorTimeoutMs).toBe(8000);
    });

    it("refuses a facilitator timeout that is not a sane number of milliseconds", () => {
        for (const bad of ["0", "-1", "900", "1.5", "soon", ""]) {
            expect(() => loadConfig({ ...base, FACILITATOR_TIMEOUT_MS: bad })).toThrow(/FACILITATOR_TIMEOUT_MS/);
        }
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
        expect(() => loadConfig({ X402_PAY_TO: "0xnope", OWNER_TOKEN: "owner-token-for-tests-only", OWNER_ADDRESS: "0x" + "9".repeat(40) })).toThrow(/20 byte hex/);
    });

    it("rejects a price that is not a plain dollar amount", () => {
        expect(() => loadConfig({ ...base, BRIEF_PRICE_USD: "3.00" })).toThrow(/BRIEF_PRICE_USD/);
        expect(() => loadConfig({ ...base, BRIEF_PRICE_USD: "$free" })).toThrow(/BRIEF_PRICE_USD/);
        expect(loadConfig({ ...base, BRIEF_PRICE_USD: "$0.01" }).priceUsd).toBe("$0.01");
    });

    it("requires the owner address whose signature approves trades", () => {
        const { OWNER_ADDRESS: _drop, ...noAddress } = base as Record<string, string>;
        expect(() => loadConfig(noAddress)).toThrow(/OWNER_ADDRESS/);
        expect(() => loadConfig({ ...base, OWNER_ADDRESS: "0xnope" })).toThrow(/OWNER_ADDRESS/);
    });

    it("binds approvals to the chain being sold on by default", () => {
        expect(loadConfig(base).approvalChainId).toBe(84532);
        expect(loadConfig({ ...base, X402_NETWORK: BASE_MAINNET, MAINNET_ENABLED: "true" }).approvalChainId).toBe(8453);
        expect(() => loadConfig({ ...base, APPROVAL_CHAIN_ID: "0" })).toThrow(/APPROVAL_CHAIN_ID/);
    });

    it("requires an owner token long enough to be a secret", () => {
        // the owner routes propose, approve and execute trades: there is no open mode and no default
        const { OWNER_TOKEN: _drop, ...noToken } = base as Record<string, string>;
        expect(() => loadConfig(noToken)).toThrow(/OWNER_TOKEN/);
        expect(() => loadConfig({ ...base, OWNER_TOKEN: "short" })).toThrow(/16 characters/);
    });

    it("keeps the investing book separate and simulated by default", () => {
        const c = loadConfig(base);
        expect(c.investMode).toBe("sim");
        expect(c.investLedgerPath).not.toBe(c.ledgerPath);
        expect(c.investLedgerPath).toMatch(/ledger-invest-sim\.jsonl$/);
    });

    it("refuses mainnet investing unless it is explicitly authorized", () => {
        expect(() => loadConfig({ ...base, INVEST_MODE: "mainnet" })).toThrow(/MAINNET_ENABLED/);
        expect(loadConfig({ ...base, INVEST_MODE: "mainnet", MAINNET_ENABLED: "true" }).investMode).toBe("mainnet");
        expect(() => loadConfig({ ...base, INVEST_MODE: "paper" })).toThrow(/INVEST_MODE/);
    });

    it("rejects an invalid port", () => {
        expect(() => loadConfig({ ...base, PORT: "0" })).toThrow(/PORT/);
        expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
    });
});
