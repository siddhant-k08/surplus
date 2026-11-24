import { describe, it, expect } from "vitest";
import { checkProposal, allPass, failures, type Leg, type Proposal } from "../src/policy";
import { allocate } from "../src/allocator";
import { parseUsdc as u } from "../src/money";
import { baseTerms, NVDA, MSFT, META, AMZN, TSLA } from "./fixtures";

const leg = (asset: string, symbol: string, theme: string, amt: string, slip = 100): Leg => ({
    asset, symbol, theme, usdcIn: u(amt), maxSlippageBps: slip,
});
const prop = (investable: string, legs: Leg[]): Proposal => ({ investable: u(investable), legs });
const failedRules = (p: Proposal) => failures(checkProposal(p, baseTerms())).map((r) => r.rule);

describe("policy", () => {
    it("passes a proposal produced by the allocator", () => {
        const terms = baseTerms();
        const { legs } = allocate({
            investable: u("0.95"),
            terms,
            themes: [
                {
                    id: "ai-compute", candidates: [
                        { asset: NVDA, symbol: "NVDAc", weight: 60 },
                        { asset: MSFT, symbol: "MSFTc", weight: 40 },
                    ]
                },
                {
                    id: "platform-giants", candidates: [
                        { asset: META, symbol: "METAc", weight: 145 },
                        { asset: AMZN, symbol: "AMZNc", weight: 140 },
                    ]
                },
            ],
        });
        expect(allPass(checkProposal({ investable: u("0.95"), legs }, terms))).toBe(true);
    });

    it("refuses NVDAc at 0.60: company cap and theme target both fail", () => {
        const p = prop("0.95", [
            leg(NVDA, "NVDAc", "ai-compute", "0.60"),
            leg(META, "METAc", "platform-giants", "0.145"),
        ]);
        const bad = failures(checkProposal(p, baseTerms()));
        const rules = bad.map((r) => r.rule);
        expect(rules).toContain("maxCompany");
        expect(rules).toContain("themeTargets");
        expect(rules).not.toContain("maxTrade");
        expect(bad.find((r) => r.rule === "maxCompany")!.detail).toMatch(/NVDAc 0\.600000 exceeds company cap 0\.380000/);
    });

    it("refuses a leg above the max trade size", () => {
        expect(failedRules(prop("5", [leg(NVDA, "NVDAc", "ai-compute", "1.50")]))).toContain("maxTrade");
    });

    it("refuses a leg below the minimum trade size", () => {
        expect(failedRules(prop("0.95", [leg(NVDA, "NVDAc", "ai-compute", "0.05")]))).toContain("minTrade");
    });

    it("refuses an asset that is not on the eligible list", () => {
        expect(failedRules(prop("0.95", [leg(TSLA, "TSLAc", "ai-compute", "0.20")]))).toContain("eligibleOnly");
    });

    it("refuses slippage above the mandate limit", () => {
        expect(failedRules(prop("0.95", [leg(NVDA, "NVDAc", "ai-compute", "0.20", 300)]))).toContain("slippage");
    });

    it("refuses a total above the investable amount", () => {
        const p = prop("0.95", [
            leg(NVDA, "NVDAc", "ai-compute", "0.35"),
            leg(MSFT, "MSFTc", "ai-compute", "0.35"),
            leg(META, "METAc", "platform-giants", "0.30"),
        ]);
        expect(failedRules(p)).toContain("totalWithinInvestable");
    });

    it("refuses a theme that is not in the mandate", () => {
        expect(failedRules(prop("0.95", [leg(NVDA, "NVDAc", "memecoins", "0.20")]))).toContain("themeTargets");
    });

    it("refuses non-positive amounts", () => {
        const p: Proposal = { investable: u("0.95"), legs: [{ ...leg(NVDA, "NVDAc", "ai-compute", "0.20"), usdcIn: 0n }] };
        expect(failedRules(p)).toContain("positiveAmounts");
    });
});

describe("a proposal that sells", () => {
    const ONE = 10n ** 18n;
    const sell = (over: Partial<Leg> = {}): Leg => ({
        asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.30"),
        maxSlippageBps: 100, side: "sell", unitsIn: ONE, ...over,
    });
    const check = (legs: Leg[], heldUnits: Map<string, bigint>, terms = baseTerms()) =>
        checkProposal({ investable: 0n, legs, heldUnits }, terms);
    const named = (rs: ReturnType<typeof checkProposal>, rule: string) => rs.find((r) => r.rule === rule)!;

    it("lets the agent sell a token the owner has since made ineligible", () => {
        // The eligible list says what may be bought. If it also gated sales it would be a trap, locking
        // the agent into exactly the position the owner just decided against.
        const terms = baseTerms({ eligible: [MSFT, META, AMZN] });
        const rs = check([sell()], new Map([[NVDA, ONE]]), terms);
        expect(named(rs, "eligibleOnly").ok).toBe(true);
        expect(allPass(rs)).toBe(true);
    });

    it("still refuses to buy a token that is not eligible", () => {
        const terms = baseTerms({ eligible: [MSFT, META, AMZN] });
        const buy: Leg = { asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.30"), maxSlippageBps: 100 };
        expect(named(checkProposal({ investable: u("1.00"), legs: [buy] }, terms), "eligibleOnly").ok).toBe(false);
    });

    it("refuses to sell more units than are held", () => {
        const rs = check([sell({ unitsIn: 3n * ONE })], new Map([[NVDA, ONE]]));
        expect(named(rs, "sellOnlyWhatIsHeld").ok).toBe(false);
        expect(named(rs, "sellOnlyWhatIsHeld").detail).toMatch(/only 1000000000000000000 are held/);
    });

    it("counts two sales of the same token together against what is held", () => {
        // each leg on its own fits; together they are short, which is the case a per-leg check would miss
        const legs = [sell({ unitsIn: ONE }), sell({ theme: "platform-giants", unitsIn: ONE })];
        expect(named(check(legs, new Map([[NVDA, ONE]])), "sellOnlyWhatIsHeld").ok).toBe(false);
        expect(named(check(legs, new Map([[NVDA, 2n * ONE]])), "sellOnlyWhatIsHeld").ok).toBe(true);
    });

    it("refuses a sale with no unit amount at all", () => {
        const rs = check([sell({ unitsIn: undefined })], new Map([[NVDA, ONE]]));
        expect(named(rs, "sellOnlyWhatIsHeld").ok).toBe(false);
    });

    it("does not need investable surplus, because a sale brings money in", () => {
        const rs = check([sell()], new Map([[NVDA, ONE]]));
        expect(named(rs, "totalWithinInvestable").ok).toBe(true);
        expect(named(rs, "maxCompany").ok).toBe(true);
        expect(named(rs, "themeTargets").ok).toBe(true);
    });

    it("still holds a sale to the mandate's trade size and slippage", () => {
        const small = check([sell({ usdcIn: u("0.01") })], new Map([[NVDA, ONE]]));
        expect(named(small, "minTrade").ok).toBe(false);
        const loose = check([sell({ maxSlippageBps: 900 })], new Map([[NVDA, ONE]]));
        expect(named(loose, "slippage").ok).toBe(false);
    });
});
