import { describe, it, expect } from "vitest";
import { loadConfig, BASE_SEPOLIA, BASE_MAINNET, USDC } from "../src/config";
import { unitEconomics } from "../src/briefs";
import { parseUsdc } from "@surplus/core";

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
        // four times the measured $0.021087 it costs to generate one, so a single sale pays for the
        // brief rather than putting the agent further behind: see the 23 Nov 2026 HANDOFF entry
        expect(c.priceUsd).toBe("$0.25");
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

/**
 * The check that was missing while the agent sold briefs below cost for days.
 *
 * The failure had no symptom of its own: `surplus.investable` simply stayed at zero and the whole
 * investing half never ran. These pin the arithmetic that now says so out loud on every boot.
 */
describe("whether a sale pays for the brief it sells", () => {
    const u = parseUsdc;

    it("reports the average cost and how far one sale covers it", () => {
        // the real figures: $0.147614 over 7 briefs is $0.021087 each, and $0.25 covers that 11.9x
        const e = unitEconomics(u("0.25"), u("0.147614"), 7);
        expect(e).not.toBeNull();
        expect(e!.perBriefUsdcMinor).toBe(u("0.021087"));
        expect(e!.covers).toBeCloseTo(11.85, 1);
        expect(e!.belowCost).toBe(false);
    });

    it("flags the price the agent actually ran on", () => {
        const e = unitEconomics(u("0.01"), u("0.147614"), 7);
        expect(e!.belowCost).toBe(true);
        expect(e!.covers).toBeLessThan(1);
    });

    it("does not flag a price that exactly meets cost", () => {
        // a brief sold at cost leaves the agent flat, which is not the error this warns about
        const e = unitEconomics(u("0.021087"), u("0.147614"), 7);
        expect(e!.belowCost).toBe(false);
        expect(e!.covers).toBe(1);
    });

    it("has no opinion on an empty catalogue, which is not a pricing fault", () => {
        expect(unitEconomics(u("0.25"), 0n, 0)).toBeNull();
        expect(unitEconomics(u("0.25"), u("1.00"), -1)).toBeNull();
    });

    it("treats a catalogue that cost nothing as uncosted rather than underpriced", () => {
        const e = unitEconomics(u("0.25"), 0n, 3);
        expect(e!.perBriefUsdcMinor).toBe(0n);
        expect(e!.covers).toBeNull();
        expect(e!.belowCost).toBe(false);
    });
});
