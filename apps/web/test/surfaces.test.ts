import { describe, it, expect } from "vitest";
import { explorerTx, explorerTokenBalance, networkName, shortHash } from "../src/explorer";
import { change, changeWords, formatUnits, ordered } from "../src/Holdings";
import { normalizeHoldings } from "../src/api";
import { stepStates, activeStep } from "../src/steps";
import {
    percentToBps, bpsToPercent, isAmount, toSeconds, parseThemeTargets, formatThemeTargets,
    changedOnly, describeChange, formatExitPercent, parseAddresses, parseExitPercent,
} from "../src/terms";
import { termsFromDraft } from "../src/MandatePanel";
import { evidenceCount, count } from "../src/Evidence";
import { route, movedTo } from "../src/App";
import { assetStake, forBrief, sharePct, themeStake, verb } from "../src/Backing";
import { driftSummary, driftWords, outsideBand } from "../src/Drift";
import { isOwnerWallet } from "../src/session";
import type { MandateTerms, Proposal, SyncResult, BriefClaim, Backing, DriftReading, ThemeDrift } from "../src/api";

const TX = "0x" + "cd".repeat(32);

describe("explorer links", () => {
    it("links a settlement to the chain it actually settled on", () => {
        expect(explorerTx("eip155:84532", TX)?.url).toBe(`https://sepolia.basescan.org/tx/${TX}`);
        expect(explorerTx("eip155:8453", TX)?.url).toBe(`https://basescan.org/tx/${TX}`);
    });

    it("refuses to link when the network was never recorded", () => {
        // the old-receipt case: guessing here would point a buyer at a transaction that is not theirs
        expect(explorerTx(null, TX)).toBeNull();
        expect(explorerTx(undefined, TX)).toBeNull();
        expect(explorerTx("", TX)).toBeNull();
    });

    it("refuses an unknown chain and a malformed hash rather than building a dead link", () => {
        expect(explorerTx("eip155:1", TX)).toBeNull();
        expect(explorerTx("solana:mainnet", TX)).toBeNull();
        expect(explorerTx("eip155:84532", "0xnope")).toBeNull();
    });

    it("names a network it cannot link to, so the page can still say where it settled", () => {
        expect(networkName("eip155:8453")).toBe("Base");
        expect(networkName("eip155:1")).toBe("eip155:1");
        expect(networkName(null)).toBeNull();
    });

    it("shortens a hash without losing its ends", () => {
        expect(shortHash(TX)).toBe(`${TX.slice(0, 10)}…${TX.slice(-6)}`);
        expect(shortHash("0xabc")).toBe("0xabc");
    });
});

describe("the owner's step rail", () => {
    const proposal = (state: string): Proposal => ({ state } as Proposal);
    const synced = { investableUsdcMinor: "0" } as SyncResult;

    it("starts on sync, with nothing else reachable", () => {
        const s = stepStates({ proposal: null, investableMinor: "0", synced: null, fills: null });
        expect(s).toEqual(["now", "later", "later", "later", "later"]);
        expect(activeStep(s)).toBe(0);
    });

    it("separates cannot-propose-yet from will-propose-later", () => {
        // after a sync that found nothing, proposing is blocked rather than merely upcoming, and the
        // two must not look the same to someone waiting
        const s = stepStates({ proposal: null, investableMinor: "0", synced, fills: null });
        expect(s[1]).toBe("blocked");
        const later = stepStates({ proposal: null, investableMinor: "0", synced: null, fills: null });
        expect(later[1]).toBe("later");
    });

    it("moves to proposing once there is investable surplus", () => {
        const s = stepStates({ proposal: null, investableMinor: "50000", synced, fills: null });
        expect(s).toEqual(["done", "now", "later", "later", "later"]);
    });

    it("puts review now and signing next while a proposal stands", () => {
        const s = stepStates({ proposal: proposal("PROPOSED"), investableMinor: "50000", synced, fills: null });
        expect(s).toEqual(["done", "done", "now", "next", "later"]);
    });

    it("sends an expired approval back to signing, and blocks executing", () => {
        const s = stepStates({
            proposal: proposal("APPROVED"), investableMinor: "50000", synced, fills: null, expired: true,
        });
        expect(s[3]).toBe("now");
        expect(s[4]).toBe("blocked");
    });

    it("is finished once fills exist", () => {
        const s = stepStates({
            proposal: proposal("SETTLED"), investableMinor: "0", synced,
            fills: { id: "p", simulated: true, warnings: [], fills: [] },
        });
        expect(s.every((x) => x === "done")).toBe(true);
    });
});

describe("mandate units", () => {
    it("converts percent to basis points on the digits, never through a float", () => {
        expect(percentToBps("40")).toBe(4000);
        expect(percentToBps("0.07")).toBe(7);
        expect(percentToBps("100")).toBe(10000);
        expect(percentToBps("12.5")).toBe(1250);
        expect(percentToBps("0.5")).toBe(50);
    });

    it("refuses a percent it cannot represent exactly in basis points", () => {
        expect(percentToBps("0.001")).toBeNull();
        expect(percentToBps("101")).toBeNull();
        expect(percentToBps("-1")).toBeNull();
        expect(percentToBps("half")).toBeNull();
        expect(percentToBps("")).toBeNull();
    });

    it("round trips basis points through the display form", () => {
        for (const bps of [0, 7, 50, 1250, 4000, 10000]) {
            expect(percentToBps(bpsToPercent(bps))).toBe(bps);
        }
        expect(bpsToPercent(4000)).toBe("40");
        expect(bpsToPercent(1250)).toBe("12.5");
    });

    it("accepts the same amount shape the server does, and no other", () => {
        expect(isAmount("1.50")).toBe(true);
        expect(isAmount("0")).toBe(true);
        expect(isAmount("1.234567")).toBe(true);
        expect(isAmount("1.2345678")).toBe(false);
        expect(isAmount("-1")).toBe(false);
        expect(isAmount("1e6")).toBe(false);
    });

    it("reads and writes theme targets as percentages", () => {
        expect(parseThemeTargets("ai-compute 50\nplatform-giants 30")).toEqual([
            { id: "ai-compute", targetBps: 5000 },
            { id: "platform-giants", targetBps: 3000 },
        ]);
        expect(parseThemeTargets("ai-compute: 50")).toEqual([{ id: "ai-compute", targetBps: 5000 }]);
        expect(formatThemeTargets([{ id: "x", targetBps: 2500 }])).toBe("x 25");
        expect(parseThemeTargets("no percentage here")).toBeNull();
        expect(parseThemeTargets("")).toBeNull();
    });

    it("takes a whole number of seconds and nothing else", () => {
        expect(toSeconds("600")).toBe(600);
        expect(toSeconds("0")).toBeNull();
        expect(toSeconds("1.5")).toBeNull();
    });
});

const terms = (over: Partial<MandateTerms> = {}): MandateTerms => ({
    eligible: ["0x" + "b2".repeat(20)],
    themes: [{ id: "ai-compute", targetBps: 5000 }],
    maxCompanyBps: 4000,
    investShareBps: 5000,
    maxSlippageBps: 50,
    driftToleranceBps: 100,
    approvalExpirySeconds: 600,
    maxTradeUsdc: "1.000000",
    minTradeUsdc: "0.050000",
    reserveTargetUsdc: "0.500000",
    ...over,
});

describe("what gets sent to the mandate", () => {
    it("sends only what changed, so the server's list of changes stays true", () => {
        const before = terms();
        const after = terms({ investShareBps: 2500 });
        expect(changedOnly(before, after)).toEqual({ investShareBps: 2500 });
    });

    it("sends nothing at all when nothing was touched", () => {
        expect(changedOnly(terms(), terms())).toEqual({});
    });

    it("never resets a term the owner did not edit", () => {
        // the whole point: a partial update carries the rest over on the server, so a term absent from
        // the payload is a term left alone
        const sent = changedOnly(terms(), terms({ reserveTargetUsdc: "2.000000" }));
        expect(Object.keys(sent)).toEqual(["reserveTargetUsdc"]);
        expect("eligible" in sent).toBe(false);
        expect("themes" in sent).toBe(false);
    });

    it("builds terms from a draft, keeping amounts as strings", () => {
        const current = terms();
        const r = termsFromDraft(current, {
            investShareBps: "25", maxCompanyBps: "40", maxSlippageBps: "0.5", driftToleranceBps: "1",
            reserveTargetUsdc: "2.00", minTradeUsdc: "0.05", maxTradeUsdc: "1.00",
            approvalExpirySeconds: "600", themes: "ai-compute 50", eligible: "0x" + "b2".repeat(20),
            investOnlyWhenAhead: "yes",
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.terms.investShareBps).toBe(2500);
        expect(r.terms.maxSlippageBps).toBe(50);
        expect(r.terms.reserveTargetUsdc).toBe("2.00");
        expect(typeof r.terms.maxTradeUsdc).toBe("string");
        expect(r.terms.investOnlyWhenAhead).toBe(true);
    });

    it("names every field it cannot accept instead of sending a guess", () => {
        const r = termsFromDraft(terms(), {
            investShareBps: "oops", maxCompanyBps: "40", maxSlippageBps: "0.5", driftToleranceBps: "1",
            reserveTargetUsdc: "2.0000000", minTradeUsdc: "0.05", maxTradeUsdc: "1.00",
            approvalExpirySeconds: "0", themes: "broken", eligible: "",
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.bad.length).toBe(5);
        expect(r.bad.join(" ")).toMatch(/percentage/);
        expect(r.bad.join(" ")).toMatch(/six decimals/);
        expect(r.bad.join(" ")).toMatch(/seconds/);
        expect(r.bad.join(" ")).toMatch(/theme/);
        expect(r.bad.join(" ")).toMatch(/eligible token address/);
    });

    it("does not offer to save a constraint the mandate never carried", () => {
        // The checkbox cannot show "absent", so an untouched mandate without the term drafts as
        // unticked and parses back as false. Offering that as a change would write a new version, and
        // invalidate every outstanding approval, to say what the mandate already said.
        const current = terms();
        expect(current.investOnlyWhenAhead).toBeUndefined();
        const r = termsFromDraft(current, {
            investShareBps: "50", maxCompanyBps: "40", maxSlippageBps: "0.5", driftToleranceBps: "1",
            reserveTargetUsdc: "0.500000", minTradeUsdc: "0.050000", maxTradeUsdc: "1.000000",
            approvalExpirySeconds: "600", themes: "ai-compute 50", eligible: "0x" + "b2".repeat(20),
            investOnlyWhenAhead: "no",
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(changedOnly(current, r.terms)).toEqual({});
    });

    it("still sends the constraint when it is actually turned on", () => {
        const r = termsFromDraft(terms(), {
            investShareBps: "50", maxCompanyBps: "40", maxSlippageBps: "0.5", driftToleranceBps: "1",
            reserveTargetUsdc: "0.500000", minTradeUsdc: "0.050000", maxTradeUsdc: "1.000000",
            approvalExpirySeconds: "600", themes: "ai-compute 50", eligible: "0x" + "b2".repeat(20),
            investOnlyWhenAhead: "yes",
        });
        if (!r.ok) return;
        expect(changedOnly(terms(), r.terms)).toEqual({ investOnlyWhenAhead: true });
        expect(changedOnly(terms({ investOnlyWhenAhead: true }), r.terms)).toEqual({});
    });

    it("reads addresses one per line and drops blanks", () => {
        expect(parseAddresses("0xaa\n\n  0xbb  \n")).toEqual(["0xaa", "0xbb"]);
    });
});

describe("the exit rules, where empty is an answer", () => {
    /**
     * The `terms()` fixture as the form would hold it, so each test varies only the rule it is about
     * and `changedOnly` reports that rule and nothing else.
     */
    const draft = (over: Record<string, string> = {}) => ({
        investShareBps: "50", maxCompanyBps: "40", maxSlippageBps: "0.5", driftToleranceBps: "1",
        reserveTargetUsdc: "0.500000", minTradeUsdc: "0.050000", maxTradeUsdc: "1.000000",
        approvalExpirySeconds: "600", themes: "ai-compute 50", eligible: "0x" + "b2".repeat(20),
        ...over,
    });

    it("reads an empty box as no rule rather than as a zero", () => {
        // A zero would sell every position the moment it was bought. Absence has to stay absence.
        const r = termsFromDraft(terms(), draft());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect("takeProfitBps" in r.terms).toBe(false);
        expect("stopLossBps" in r.terms).toBe(false);
        expect("rebalanceBandBps" in r.terms).toBe(false);
    });

    it("sends nothing when the mandate had no rules and the owner set none", () => {
        const r = termsFromDraft(terms(), draft());
        if (!r.ok) return;
        expect(changedOnly(terms(), r.terms)).toEqual({});
    });

    it("turns a typed percentage into basis points", () => {
        const r = termsFromDraft(terms(), draft({ takeProfitBps: "25", rebalanceBandBps: "5" }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.terms.takeProfitBps).toBe(2500);
        expect(r.terms.rebalanceBandBps).toBe(500);
        expect(changedOnly(terms(), r.terms)).toEqual({ takeProfitBps: 2500, rebalanceBandBps: 500 });
    });

    it("sends null to remove a rule, never an absent key", () => {
        // The one that matters. The server carries over every term an update does not mention, so an
        // omitted key would leave the agent still allowed to sell on a rule the owner just cleared.
        const current = terms({ stopLossBps: 1500 });
        const r = termsFromDraft(current, draft({ stopLossBps: "" }));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const sent = changedOnly(current, r.terms);
        expect(sent).toEqual({ stopLossBps: null });
        expect("stopLossBps" in sent).toBe(true);
    });

    it("refuses a stop loss of the whole position", () => {
        const r = termsFromDraft(terms(), draft({ stopLossBps: "100" }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.bad.join(" ")).toMatch(/cannot lose more than all of it/);
    });

    it("refuses a rule of zero, which is not a rule", () => {
        const r = termsFromDraft(terms(), draft({ takeProfitBps: "0" }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.bad.join(" ")).toMatch(/Take profit at must be a percentage above zero/);
    });

    it("keeps the live rule when the box is malformed, so a typo never reads as a removal", () => {
        const current = terms({ takeProfitBps: 2500 });
        const r = termsFromDraft(current, draft({ takeProfitBps: "2.5.5" }));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        // the save is blocked either way; what matters is that it was not about to clear the rule
        const rebuilt = termsFromDraft(current, draft({ takeProfitBps: "25" }));
        if (!rebuilt.ok) return;
        expect(changedOnly(current, rebuilt.terms)).toEqual({});
    });

    it("says setting and clearing a rule in words the owner can check", () => {
        const none = terms();
        const set = terms({ rebalanceBandBps: 500 });
        expect(describeChange("rebalanceBandBps", none, set)).toBe("Trim a theme past: not set → 5%");
        expect(describeChange("rebalanceBandBps", set, none)).toBe("Trim a theme past: 5% → not set");
    });

    it("round-trips a rule through the form and back", () => {
        expect(formatExitPercent(undefined)).toBe("");
        expect(formatExitPercent(500)).toBe("5");
        expect(parseExitPercent("")).toEqual({ ok: true });
        expect(parseExitPercent("  ")).toEqual({ ok: true });
        expect(parseExitPercent("5")).toEqual({ ok: true, bps: 500 });
        expect(parseExitPercent("0")).toEqual({ ok: false });
        expect(parseExitPercent("0.004")).toEqual({ ok: false });
        expect(parseExitPercent("nope")).toEqual({ ok: false });
    });
});

describe("reading the drift against a band", () => {
    const theme = (over: Partial<ThemeDrift> = {}): ThemeDrift => ({
        theme: "ai-compute",
        valueUsdcMinor: "877599",
        actualBps: 6251,
        targetBps: 6250,
        driftBps: 1,
        excessUsdcMinor: "196",
        overBand: false,
        ...over,
    });
    const reading = (themes: ThemeDrift[], bandBps: number | null = null): DriftReading => ({
        themes,
        totalUsdcMinor: "1403845",
        untargetedUsdcMinor: "0",
        bandBps,
        asOf: "2026-11-25T04:00:00.000Z",
    });

    it("says nothing is trimmed when the mandate states no band", () => {
        // The state the live mandate was in for weeks, and the one an owner is in while deciding.
        expect(driftSummary(reading([theme()]), undefined))
            .toBe("No band is set, so no theme is trimmed however far it drifts.");
    });

    it("measures against the band in the form, not the one that is saved", () => {
        // A band typed but not saved is exactly what the reading is for: it answers "is this number
        // worth saving" before the version is written.
        const drifted = theme({ driftBps: 700 });
        expect(outsideBand(drifted, 500)).toBe(true);
        expect(outsideBand(drifted, 1000)).toBe(false);
        expect(driftSummary(reading([drifted]), 500)).toBe("ai-compute sits outside a 5% band.");
        expect(driftSummary(reading([drifted]), 1000))
            .toBe("Every theme is inside a 10% band, so nothing would be trimmed.");
    });

    it("never calls a theme outside a band when no band is being considered", () => {
        expect(outsideBand(theme({ driftBps: 9000 }), undefined)).toBe(false);
    });

    it("counts only themes above their target, since a sale cannot fix an under-weight one", () => {
        const under = theme({ theme: "platform-giants", driftBps: -900 });
        expect(outsideBand(under, 500)).toBe(false);
        expect(driftSummary(reading([theme(), under]), 500))
            .toBe("Every theme is inside a 5% band, so nothing would be trimmed.");
    });

    it("names both themes when both are out", () => {
        const a = theme({ driftBps: 700 });
        const b = theme({ theme: "platform-giants", driftBps: 800 });
        expect(driftSummary(reading([a, b]), 500))
            .toBe("ai-compute and platform-giants sit outside a 5% band.");
    });

    it("says there is nothing to compare before anything is held", () => {
        expect(driftSummary(reading([]), 500)).toBe("Nothing is held yet, so there are no weights to compare.");
    });

    it("reads a drift in words, with the direction stated", () => {
        expect(driftWords(0)).toBe("on target");
        expect(driftWords(1)).toBe("0.01% above target");
        expect(driftWords(-250)).toBe("2.5% below target");
    });
});

describe("telling the owner from a buyer", () => {
    const OWNER = "0x322472B62a297249234B258a48Df86ce8D620D48";

    it("recognises the owner's wallet whatever the capitalisation", () => {
        // One side is checksummed by the wallet, the other is whatever was typed into the
        // environment. An address that differs only in case is the same address.
        expect(isOwnerWallet(OWNER, OWNER)).toBe(true);
        expect(isOwnerWallet(OWNER.toLowerCase(), OWNER)).toBe(true);
        expect(isOwnerWallet(OWNER, OWNER.toLowerCase())).toBe(true);
    });

    it("does not recognise anyone else", () => {
        expect(isOwnerWallet("0x" + "b2".repeat(20), OWNER)).toBe(false);
    });

    it("never guesses from a missing side", () => {
        // A page that has read neither the wallet nor the catalogue must show a stranger nothing.
        expect(isOwnerWallet(null, OWNER)).toBe(false);
        expect(isOwnerWallet(OWNER, null)).toBe(false);
        expect(isOwnerWallet(OWNER, undefined)).toBe(false);
        expect(isOwnerWallet(OWNER, "")).toBe(false);
        expect(isOwnerWallet(null, null)).toBe(false);
    });
});

describe("evidence counting", () => {
    const claims = new Map<string, BriefClaim>([
        ["c1", { id: "c1", type: "fact", text: "a", sourceIds: ["s1"], quotes: [{ sourceId: "s1", text: "q1" }, { sourceId: "s1", text: "q2" }] }],
        ["c2", { id: "c2", type: "fact", text: "b", sourceIds: ["s1"] }],
    ]);

    it("counts every claim and every quote, not just the first of each", () => {
        // the bug this replaces: the page rendered claimIds[0] and quotes[0] and showed no sign of more
        expect(evidenceCount({ claimIds: ["c1", "c2"] }, claims)).toEqual({ claims: 2, quotes: 2, missing: 0 });
    });

    it("counts a cited claim that is not in the brief as missing rather than ignoring it", () => {
        expect(evidenceCount({ claimIds: ["c1", "gone"] }, claims)).toEqual({ claims: 1, quotes: 2, missing: 1 });
    });

    it("says nothing is there when a fit cites nothing", () => {
        expect(evidenceCount({ claimIds: [] }, claims)).toEqual({ claims: 0, quotes: 0, missing: 0 });
    });

    it("pluralises without writing (s) at a reader", () => {
        expect(count(1, "claim")).toBe("1 claim");
        expect(count(2, "claim")).toBe("2 claims");
        expect(count(2, "company", "companies")).toBe("2 companies");
    });
});

/**
 * The router is the one piece of this app that decides what a person sees, so it is tested like
 * logic rather than trusted like markup. The cases that matter are the ones a URL bar produces: a
 * trailing slash, a retired path somebody shared, and a receipt id that is not one.
 */
describe("routing", () => {
    it("finds every page", () => {
        expect(route("/").k).toBe("home");
        expect(route("/themes").k).toBe("themes");
        expect(route("/filings").k).toBe("filings");
        expect(route("/app").k).toBe("app");
        expect(route("/app/library").k).toBe("library");
    });

    it("reads the desk's three tabs", () => {
        expect(route("/desk")).toEqual({ k: "desk", tab: "decision" });
        expect(route("/desk/mandate")).toEqual({ k: "desk", tab: "mandate" });
        expect(route("/desk/book")).toEqual({ k: "desk", tab: "book" });
    });

    it("ignores a trailing slash, which a browser and a shared link both add", () => {
        expect(route("/themes/").k).toBe("themes");
        expect(route("/app/library/").k).toBe("library");
        expect(route("/").k).toBe("home");
    });

    it("carries a receipt id out of the path", () => {
        const found = route("/r/abcdef0123456789");
        expect(found).toEqual({ k: "receipt", id: "abcdef0123456789" });
    });

    it("refuses a receipt id that is too short or not an id at all", () => {
        expect(route("/r/short").k).toBe("missing");
        expect(route("/r/has spaces in it here").k).toBe("missing");
        expect(route("/r/../../etc/passwd").k).toBe("missing");
    });

    it("sends a retired path to the page that replaced it", () => {
        expect(movedTo("/library")).toBe("/app/library");
        // "Portfolio" was the wrong word for a shelf of documents, and a link someone already shared
        // must not become a 404 because the vocabulary improved.
        expect(movedTo("/app/portfolio")).toBe("/app/library");
        expect(movedTo("/store")).toBe("/app");
        expect(movedTo("/themes")).toBe(null);
        expect(movedTo("/nope")).toBe(null);
    });

    it("answers anything else with the page that offers a way out", () => {
        expect(route("/invest").k).toBe("missing");
        expect(route("/app/library/extra").k).toBe("missing");
    });
});


/** What the public route returns, with one token bought under two themes, as the real one does. */
const backed: Backing = {
    attributedUsdcMinor: "490296",
    totalUsdcMinor: "966682",
    unattributed: { usdcMinor: "476386", fills: 8 },
    briefs: [
        {
            briefId: "brief-2026-11-21T19-57-41-888Z",
            usdcMinor: "490296",
            mode: "sim",
            simulated: true,
            fills: 8,
            onchainFills: 0,
            firstAt: "2026-11-24T17:57:50.068Z",
            lastAt: "2026-11-24T17:57:50.068Z",
            themes: [
                {
                    theme: "ai-compute",
                    usdcMinor: "303242",
                    assets: [
                        { asset: "0xaaa", symbol: "GOOGLc", usdcMinor: "67387", fills: 1, sales: 0, onchainFills: 0, transactions: [] },
                        { asset: "0xbbb", symbol: "METAc", usdcMinor: "55135", fills: 1, sales: 0, onchainFills: 0, transactions: [] },
                    ],
                },
                {
                    theme: "platform-giants",
                    usdcMinor: "187054",
                    assets: [
                        { asset: "0xbbb", symbol: "METAc", usdcMinor: "67869", fills: 1, sales: 0, onchainFills: 0, transactions: [] },
                    ],
                },
            ],
        },
    ],
};

describe("what the agent put behind a brief", () => {
    it("finds the brief being read, and nothing for one it has not acted on", () => {
        expect(forBrief(backed, "brief-2026-11-21T19-57-41-888Z")?.usdcMinor).toBe("490296");
        expect(forBrief(backed, "brief-nobody-bought")).toBeNull();
        expect(forBrief(null, "brief-2026-11-21T19-57-41-888Z")).toBeNull();
    });

    it("reads one theme's share, and null for a theme that got nothing", () => {
        const brief = forBrief(backed, "brief-2026-11-21T19-57-41-888Z");
        expect(themeStake(brief, "ai-compute")).toBe("303242");
        expect(themeStake(brief, "longevity-biotech")).toBeNull();
        expect(themeStake(null, "ai-compute")).toBeNull();
    });

    it("keeps one company's two themes apart", () => {
        // METAc was bought under both. Showing the same figure in both places, or the sum in one, would
        // misreport which research argument the money was actually behind.
        const brief = forBrief(backed, "brief-2026-11-21T19-57-41-888Z");
        expect(assetStake(brief, "ai-compute", "METAc")).toBe("55135");
        expect(assetStake(brief, "platform-giants", "METAc")).toBe("67869");
        expect(assetStake(brief, "ai-compute", "GOOGLc")).toBe("67387");
        // a company the brief names but the mandate's caps left out gets no column, not a zero
        expect(assetStake(brief, "ai-compute", "TSLAc")).toBeNull();
        expect(assetStake(brief, "platform-giants", "GOOGLc")).toBeNull();
    });

    it("sizes a bar by share, and never divides by zero", () => {
        expect(sharePct("303242", "490296")).toBeCloseTo(61.84, 1);
        expect(sharePct("187054", "490296")).toBeCloseTo(38.15, 1);
        expect(sharePct("1", "0")).toBe(0);
        expect(sharePct("0", "0")).toBe(0);
        // the two themes account for the whole, give or take the rounding a bar cannot show anyway
        expect(sharePct("303242", "490296") + sharePct("187054", "490296")).toBeCloseTo(100, 0);
    });

    it("says committed while fills are simulated, and holds only once they are not", () => {
        // The one sentence on the site that could be false. A simulated fill bought nothing.
        expect(verb(true)).toBe("committed");
        expect(verb(false)).toBe("holds");
    });
});

describe("the holdings table", () => {
    it("shows units as whole tokens, exactly", () => {
        expect(formatUnits("126944672", 8)).toBe("1.26944672");
        expect(formatUnits("100000000", 8)).toBe("1");
        expect(formatUnits("5826500000000000", 18)).toBe("0.0058265");
        expect(formatUnits("0", 8)).toBe("0");
        // without decimals it says what the number is rather than guessing
        expect(formatUnits("123", null)).toBe("123 units");
    });

    it("measures value against cost, and says nothing without a value", () => {
        expect(change({ costUsdcMinor: "1000000", valueUsdcMinor: "1050000" })).toEqual({ usdc: 50000n, bps: 500 });
        expect(change({ costUsdcMinor: "1000000", valueUsdcMinor: null })).toBeNull();
        expect(change({ costUsdcMinor: "0", valueUsdcMinor: "5" })).toBeNull();
        expect(changeWords({ usdc: -25000n, bps: -250 })).toBe("-0.025000 (-2.50%)");
        expect(changeWords({ usdc: 50000n, bps: 500 })).toBe("+0.050000 (+5.00%)");
    });

    it("lists open positions first, largest first, and keeps closed ones", () => {
        const h = (symbol: string, units: string, cost: string) => ({
            asset: symbol, symbol, units, costUsdcMinor: cost, realizedUsdcMinor: "0",
            buys: 1, sells: 0, decimals: 8, transactions: [],
        });
        expect(ordered([h("A", "0", "0"), h("B", "5", "10"), h("C", "5", "30")]).map((x) => x.symbol))
            .toEqual(["C", "B", "A"]);
    });

    it("links a wallet's token balance on the explorer of its chain", () => {
        const token = "0x" + "b2".repeat(20);
        const wallet = "0x" + "11".repeat(20);
        expect(explorerTokenBalance("eip155:8453", token, wallet)?.url)
            .toBe(`https://basescan.org/token/${token}?a=${wallet}`);
        expect(explorerTokenBalance("eip155:1", token, wallet)).toBeNull();
        expect(explorerTokenBalance("eip155:8453", "nope", wallet)).toBeNull();
    });
});

describe("holdings from an older server", () => {
    it("reads a response without the new fields instead of crashing", () => {
        // the shape the API answered with before the holdings table existed
        const h = normalizeHoldings({
            positions: [{ asset: "0xab", symbol: "NVDAc", units: "5", costUsdcMinor: "10", realizedUsdcMinor: "0", buys: 1, sells: 0 }],
            realizedUsdcMinor: "0",
        });
        expect(h.positions[0]!.transactions).toEqual([]);
        expect(h.positions[0]!.decimals).toBeNull();
        expect(formatUnits(h.positions[0]!.units, h.positions[0]!.decimals)).toBe("5 units");
        // never claims tokens exist when the server did not say
        expect(h.simulated).toBe(true);
    });
});
