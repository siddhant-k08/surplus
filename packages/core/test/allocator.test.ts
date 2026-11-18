import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allocate, type ThemeInput } from "../src/allocator";
import { checkProposal, allPass } from "../src/policy";
import { parseUsdc as u } from "../src/money";
import { baseTerms, addr, NVDA, MSFT, META, AMZN, TSLA } from "./fixtures";

const sumLegs = (r: ReturnType<typeof allocate>) => r.legs.reduce((a, l) => a + l.usdcIn, 0n);
const sumUn = (r: ReturnType<typeof allocate>) => r.uninvested.reduce((a, x) => a + x.amount, 0n);
const one = (id: string, ...c: [string, string, number][]): ThemeInput => ({
    id,
    candidates: c.map(([asset, symbol, weight]) => ({ asset, symbol, weight })),
});

describe("allocator", () => {
    it("reproduces the section 3 proposal", () => {
        const r = allocate({
            investable: u("0.95"),
            terms: baseTerms(),
            themes: [
                one("ai-compute", [NVDA, "NVDAc", 60], [MSFT, "MSFTc", 40]),
                one("platform-giants", [META, "METAc", 145], [AMZN, "AMZNc", 140]),
            ],
        });
        const by = Object.fromEntries(r.legs.map((l) => [l.symbol, l.usdcIn]));
        expect(by).toEqual({
            NVDAc: u("0.285"),
            MSFTc: u("0.190"),
            METAc: u("0.145"),
            AMZNc: u("0.140"),
        });
        expect(r.uninvested).toEqual([{ theme: "longevity-biotech", amount: u("0.19"), reason: "gap" }]);
        expect(sumLegs(r) + sumUn(r)).toBe(u("0.95"));
    });

    it("moves excess from a capped company to the others in the same theme", () => {
        const terms = baseTerms({ themes: [{ id: "t", targetBps: 10_000 }], maxCompanyBps: 6000 });
        const r = allocate({ investable: u("1"), terms, themes: [one("t", [NVDA, "NVDAc", 90], [MSFT, "MSFTc", 10])] });
        const by = Object.fromEntries(r.legs.map((l) => [l.symbol, l.usdcIn]));
        expect(by).toEqual({ NVDAc: u("0.60"), MSFTc: u("0.40") });
        expect(r.uninvested).toEqual([]);
    });

    it("leaves the excess uninvested when every company is capped", () => {
        const terms = baseTerms({ themes: [{ id: "t", targetBps: 10_000 }], maxCompanyBps: 4000 });
        const r = allocate({ investable: u("1"), terms, themes: [one("t", [NVDA, "NVDAc", 1])] });
        expect(r.legs.map((l) => l.usdcIn)).toEqual([u("0.40")]);
        expect(r.uninvested).toEqual([{ theme: "t", amount: u("0.60"), reason: "company_cap" }]);
    });

    it("clips a leg to the max trade size", () => {
        const terms = baseTerms({ themes: [{ id: "t", targetBps: 10_000 }], maxCompanyBps: 10_000, maxTradeUsdc: u("0.30") });
        const r = allocate({ investable: u("1"), terms, themes: [one("t", [NVDA, "NVDAc", 1])] });
        expect(r.legs.map((l) => l.usdcIn)).toEqual([u("0.30")]);
        expect(r.uninvested).toEqual([{ theme: "t", amount: u("0.70"), reason: "max_trade" }]);
    });

    it("drops legs below the minimum trade size", () => {
        const terms = baseTerms({ themes: [{ id: "t", targetBps: 10_000 }], maxCompanyBps: 10_000 });
        const r = allocate({ investable: u("0.15"), terms, themes: [one("t", [NVDA, "NVDAc", 1], [MSFT, "MSFTc", 1])] });
        expect(r.legs).toEqual([]);
        expect(sumUn(r)).toBe(u("0.15"));
        expect(r.uninvested.every((x) => x.reason === "below_minimum")).toBe(true);
    });

    it("ignores ineligible candidates and reports a gap", () => {
        const terms = baseTerms({ themes: [{ id: "t", targetBps: 10_000 }] });
        const r = allocate({ investable: u("1"), terms, themes: [one("t", [TSLA, "TSLAc", 1])] });
        expect(r.legs).toEqual([]);
        expect(r.uninvested).toEqual([{ theme: "t", amount: u("1"), reason: "gap" }]);
    });

    it("keeps unassigned target share uninvested", () => {
        const terms = baseTerms({ themes: [{ id: "t", targetBps: 5000 }], maxCompanyBps: 10_000 });
        const r = allocate({ investable: u("1"), terms, themes: [one("t", [NVDA, "NVDAc", 1])] });
        expect(r.legs.map((l) => l.usdcIn)).toEqual([u("0.50")]);
        expect(r.uninvested).toEqual([{ theme: null, amount: u("0.50"), reason: "unassigned" }]);
    });

    it("rejects a theme that has no target in the mandate", () => {
        expect(() => allocate({ investable: u("1"), terms: baseTerms(), themes: [one("nope", [NVDA, "NVDAc", 1])] })).toThrow(/no target/);
    });

    it("property: nothing is created or lost, and the policy engine accepts the result", () => {
        const tokens = ["a", "b", "c", "d", "e"].map((c) => addr(c));
        const cand = fc.record({
            asset: fc.constantFrom(...tokens),
            weight: fc.integer({ min: 1, max: 1000 }),
        });
        const themeCands = fc.uniqueArray(cand, { selector: (c) => c.asset, maxLength: 5 });
        fc.assert(
            fc.property(
                fc.bigInt({ min: 0n, max: 5_000_000_000n }),
                fc.array(fc.integer({ min: 1, max: 3333 }), { minLength: 1, maxLength: 3 }),
                fc.integer({ min: 1, max: 10_000 }),
                fc.integer({ min: 1, max: 5_000_000 }),
                fc.integer({ min: 1, max: 5_000_000 }),
                fc.array(themeCands, { minLength: 3, maxLength: 3 }),
                (investable, bps, maxCompanyBps, a, b, cands) => {
                    const lo = BigInt(Math.min(a, b));
                    const hi = BigInt(Math.max(a, b));
                    const themes = bps.map((targetBps, i) => ({ id: `t${i}`, targetBps }));
                    const terms = baseTerms({
                        eligible: tokens,
                        themes,
                        maxCompanyBps,
                        minTradeUsdc: lo,
                        maxTradeUsdc: hi,
                    });
                    const inputs: ThemeInput[] = themes.map((t, i) => ({
                        id: t.id,
                        candidates: (cands[i] ?? []).map((c, j) => ({ asset: c.asset, symbol: `S${j}`, weight: c.weight })),
                    }));
                    const r = allocate({ investable, terms, themes: inputs });
                    expect(sumLegs(r) + sumUn(r)).toBe(investable);
                    expect(allPass(checkProposal({ investable, legs: r.legs }, terms))).toBe(true);
                },
            ),
            { numRuns: 500 },
        );
    });
});