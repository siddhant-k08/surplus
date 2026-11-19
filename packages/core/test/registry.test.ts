import { describe, it, expect } from "vitest";
import { BASE_REGISTRY, crossCheck } from "../src/registry";
import type { TokenRecord } from "../src/tokens";
import { addr } from "./fixtures";

const tok = (address: string, symbol: string): TokenRecord => ({
    address,
    symbol,
    name: symbol,
    decimals: 18,
    isin: null,
    multiplier: 1,
    pausedFeatures: [],
    navPrice: null,
    navUpdatedAt: null,
    totalSupply: null,
});

const reg = [
    { symbol: "AAAc", name: "A", address: addr("a") },
    { symbol: "BBBc", name: "B", address: addr("b") },
];

describe("registry", () => {
    it("pins ten unique, well-formed lowercase addresses", () => {
        expect(BASE_REGISTRY).toHaveLength(10);
        const addrs = BASE_REGISTRY.map((r) => r.address);
        expect(new Set(addrs).size).toBe(10);
        for (const a of addrs) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("trusts only the intersection and reports the differences", () => {
        const r = crossCheck([tok(addr("a"), "AAAc"), tok(addr("e"), "EEEc")], reg);
        expect(r.trusted.map((t) => t.symbol)).toEqual(["AAAc"]);
        expect(r.apiOnly.map((t) => t.symbol)).toEqual(["EEEc"]);
        expect(r.missingFromApi.map((x) => x.symbol)).toEqual(["BBBc"]);
        expect(r.symbolMismatch).toEqual([]);
    });

    it("does not trust a token whose symbol differs from the registry", () => {
        const r = crossCheck([tok(addr("a"), "FAKEc")], reg);
        expect(r.trusted).toEqual([]);
        expect(r.symbolMismatch).toEqual([{ address: addr("a"), registrySymbol: "AAAc", apiSymbol: "FAKEc" }]);
    });

    it("matches addresses case-insensitively", () => {
        const mixed = "0x" + "A".repeat(40);
        const r = crossCheck([tok(mixed, "AAAc")], reg);
        expect(r.trusted).toHaveLength(1);
        expect(r.missingFromApi.map((x) => x.symbol)).toEqual(["BBBc"]);
    });
});