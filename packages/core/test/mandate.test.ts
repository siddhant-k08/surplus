import { describe, it, expect } from "vitest";
import { MandateStore, canonicalJson, diffTerms } from "../src/mandate";
import { parseUsdc as u } from "../src/money";
import { baseTerms, NVDA, MSFT } from "./fixtures";

describe("mandate", () => {
    it("creates version 1 and normalizes eligible addresses", () => {
        const s = new MandateStore();
        const v = s.create(baseTerms({ eligible: [NVDA.toUpperCase().replace("0X", "0x"), MSFT, NVDA] }));
        expect(v.version).toBe(1);
        expect(v.prevHash).toBeNull();
        expect(v.terms.eligible).toEqual([NVDA, MSFT]);
    });

    it("chains versions and changes the hash when terms change", () => {
        const s = new MandateStore();
        const v1 = s.create(baseTerms());
        const v2 = s.create(baseTerms({ maxCompanyBps: 3000 }));
        expect(v2.version).toBe(2);
        expect(v2.prevHash).toBe(v1.hash);
        expect(v2.hash).not.toBe(v1.hash);
        expect(s.current()).toBe(v2);
    });

    it("is deterministic across stores", () => {
        const a = new MandateStore().create(baseTerms());
        const b = new MandateStore().create(baseTerms());
        expect(a.hash).toBe(b.hash);
    });

    it("rejects invalid terms", () => {
        const s = new MandateStore();
        expect(() => s.create(baseTerms({ themes: [{ id: "a", targetBps: 6000 }, { id: "b", targetBps: 5000 }] }))).toThrow(/sum/);
        expect(() => s.create(baseTerms({ minTradeUsdc: u("2"), maxTradeUsdc: u("1") }))).toThrow(/maxTradeUsdc/);
        expect(() => s.create(baseTerms({ eligible: ["0x123"] }))).toThrow(/Invalid token address/);
        expect(() => s.create(baseTerms({ themes: [{ id: "a", targetBps: 1000 }, { id: "a", targetBps: 1000 }] }))).toThrow(/Duplicate/);
        expect(() => s.create(baseTerms({ maxSlippageBps: 20_000 }))).toThrow(/maxSlippageBps/);
    });

    it("verifies the chain and diffs terms", () => {
        const s = new MandateStore();
        s.create(baseTerms());
        s.create(baseTerms({ investShareBps: 2500, maxTradeUsdc: u("0.50") }));
        expect(s.verifyChain()).toBe(true);
        expect(diffTerms(s.get(1)!.terms, s.get(2)!.terms)).toEqual(["investShareBps", "maxTradeUsdc"]);
    });

    it("canonicalJson ignores key order", () => {
        expect(canonicalJson({ b: 1, a: [2n, { d: 1, c: 2 }] })).toBe(
            canonicalJson({ a: [2n, { c: 2, d: 1 }], b: 1 }),
        );
    });
});