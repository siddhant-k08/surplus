import { describe, it, expect } from "vitest";
import { backing } from "../src/backing";
import { Ledger } from "../src/ledger";
import { Treasury } from "../src/treasury";
import { MandateStore } from "../src/mandate";
import { allocate } from "../src/allocator";
import { parseUsdc as u } from "../src/money";
import { positionsFromLedger } from "../src/positions";
import { reconcileInternal } from "../src/reconcile";
import { baseTerms, NVDA, MSFT, META, AMZN } from "./fixtures";

const T0 = Date.parse("2026-11-24T12:00:00Z");

/** A fill as the ledger holds it, so the attribution can be tested without driving a whole proposal. */
function fill(
    ledger: Ledger,
    i: { at: number; asset: string; usdcIn: bigint; briefId?: string; theme?: string; txHash?: string },
): void {
    ledger.post({
        type: "PURCHASE_SETTLED",
        mode: "sim",
        at: new Date(i.at),
        idempotencyKey: `fill:${i.asset}:${i.at}:${i.theme ?? "none"}`,
        ...(i.briefId !== undefined && { briefId: i.briefId }),
        ...(i.theme !== undefined && { theme: i.theme }),
        ...(i.txHash !== undefined && { txHash: i.txHash }),
        lines: [
            { account: `positions.${i.asset}`, amount: i.usdcIn },
            { account: "surplus.investable", amount: -i.usdcIn },
        ],
    });
}

describe("what the agent has put behind its own research", () => {
    it("groups a brief's fills by theme and by token, biggest first", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.06"), briefId: "b1", theme: "ai-compute" });
        fill(ledger, { at: T0 + 1000, asset: MSFT, usdcIn: u("0.05"), briefId: "b1", theme: "ai-compute" });
        fill(ledger, { at: T0 + 2000, asset: META, usdcIn: u("0.20"), briefId: "b1", theme: "platform-giants" });

        const r = backing(ledger.all());
        expect(r.briefs).toHaveLength(1);
        const b = r.briefs[0]!;
        expect(b.briefId).toBe("b1");
        expect(b.usdcIn).toBe(u("0.31"));
        expect(b.fills).toBe(3);
        // the bigger theme leads, and inside it the bigger holding
        expect(b.themes.map((t) => t.theme)).toEqual(["platform-giants", "ai-compute"]);
        expect(b.themes[1]!.assets.map((a) => a.asset)).toEqual([NVDA, MSFT]);
        expect(b.themes[0]!.usdcIn).toBe(u("0.20"));
        expect(r.totalUsdcIn).toBe(u("0.31"));
    });

    it("keeps one token bought under two themes apart", () => {
        // This is why the theme is a field on the entry and not a line in the memo: the same token in two
        // themes is one position onchain but two different research arguments.
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: META, usdcIn: u("0.05"), briefId: "b1", theme: "ai-compute" });
        fill(ledger, { at: T0 + 1000, asset: META, usdcIn: u("0.07"), briefId: "b1", theme: "platform-giants" });

        const b = backing(ledger.all()).briefs[0]!;
        expect(b.themes).toHaveLength(2);
        expect(b.themes.find((t) => t.theme === "ai-compute")!.assets[0]!.usdcIn).toBe(u("0.05"));
        expect(b.themes.find((t) => t.theme === "platform-giants")!.assets[0]!.usdcIn).toBe(u("0.07"));
        expect(b.usdcIn).toBe(u("0.12"));
    });

    it("adds up repeat buys of the same token in the same theme", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.05"), briefId: "b1", theme: "ai-compute" });
        fill(ledger, { at: T0 + 1000, asset: NVDA, usdcIn: u("0.06"), briefId: "b1", theme: "ai-compute" });

        const b = backing(ledger.all()).briefs[0]!;
        expect(b.themes[0]!.assets).toHaveLength(1);
        expect(b.themes[0]!.assets[0]!.usdcIn).toBe(u("0.11"));
        expect(b.themes[0]!.assets[0]!.fills).toBe(2);
    });

    it("calls a fill simulated until one of them reaches a chain", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.05"), briefId: "b1", theme: "ai-compute" });
        expect(backing(ledger.all()).briefs[0]!.simulated).toBe(true);
        expect(backing(ledger.all()).briefs[0]!.onchainFills).toBe(0);

        fill(ledger, { at: T0 + 1000, asset: MSFT, usdcIn: u("0.05"), briefId: "b1", theme: "ai-compute", txHash: "0xabc" });
        const b = backing(ledger.all()).briefs[0]!;
        expect(b.simulated).toBe(false);
        expect(b.onchainFills).toBe(1);
        expect(b.fills).toBe(2);
        // a mixed brief is visible as mixed rather than rounded to one answer or the other
        expect(b.themes[0]!.assets.find((a) => a.asset === MSFT)!.transactions).toEqual(["0xabc"]);
        expect(b.themes[0]!.assets.find((a) => a.asset === NVDA)!.transactions).toEqual([]);
    });

    it("refuses to credit a brief for a position it cannot be shown to have justified", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.05"), briefId: "b1", theme: "ai-compute" });
        // a fill from a demo with no brief, and one booked before the theme field existed
        fill(ledger, { at: T0 + 1000, asset: MSFT, usdcIn: u("0.07") });
        fill(ledger, { at: T0 + 2000, asset: AMZN, usdcIn: u("0.09"), briefId: "b1" });

        const r = backing(ledger.all());
        expect(r.briefs[0]!.usdcIn).toBe(u("0.05"));
        expect(r.unattributed).toEqual({ usdcIn: u("0.16"), fills: 2 });
        // the parts still add up, which is the point of reporting the remainder at all
        expect(r.briefs[0]!.usdcIn + r.unattributed.usdcIn).toBe(r.totalUsdcIn);
    });

    it("puts the brief the agent acted on most recently first", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.40"), briefId: "older", theme: "ai-compute" });
        fill(ledger, { at: T0 + 5000, asset: MSFT, usdcIn: u("0.05"), briefId: "newer", theme: "ai-compute" });

        expect(backing(ledger.all()).briefs.map((b) => b.briefId)).toEqual(["newer", "older"]);
    });

    it("ignores everything that is not a fill", () => {
        const ledger = new Ledger();
        ledger.post({
            type: "PAYMENT_RECEIVED", mode: "sim", at: new Date(T0), briefId: "b1",
            lines: [{ account: "cash.operating", amount: u("0.25") }, { account: "revenue.research", amount: u("-0.25") }],
        });
        ledger.post({
            type: "SURPLUS_ALLOCATED", mode: "sim", at: new Date(T0 + 1), briefId: "b1",
            lines: [{ account: "cash.operating", amount: u("-0.20") }, { account: "surplus.investable", amount: u("0.20") }],
        });
        const r = backing(ledger.all());
        expect(r.briefs).toEqual([]);
        expect(r.totalUsdcIn).toBe(0n);
    });

    it("refuses a fill with no position line rather than reporting a smaller number", () => {
        const ledger = new Ledger();
        ledger.post({
            type: "PURCHASE_SETTLED", mode: "sim", at: new Date(T0), briefId: "b1", theme: "ai-compute",
            lines: [{ account: "surplus.investable", amount: u("-0.05") }, { account: "cash.operating", amount: u("0.05") }],
        });
        expect(() => backing(ledger.all())).toThrow(/no positions line/);
    });

    it("survives a round trip through the ledger's own replay", () => {
        // The fields the attribution depends on are the ones a restart has to bring back. If `theme` were
        // dropped by replay, every position would become unattributed the moment the process restarted.
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: META, usdcIn: u("0.07"), briefId: "b1", theme: "platform-giants", txHash: "0xdef" });
        const replayed = Ledger.replay(ledger.all());
        expect(backing(replayed.all())).toEqual(backing(ledger.all()));
        expect(replayed.all()[0]!.theme).toBe("platform-giants");
    });
});

describe("a real proposal, from legs to attribution", () => {
    it("books the brief and theme onto every fill it settles", () => {
        const clock = { t: T0, now: () => new Date(clock.t) };
        const mandates = new MandateStore();
        mandates.create(baseTerms(), clock.now());
        const tr = new Treasury({ mode: "sim", mandates, now: clock.now });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "sim", at: clock.now(),
            lines: [{ account: "reserve", amount: u("2.00") }, { account: "equity.opening", amount: u("-2.00") }],
        });
        tr.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
        tr.settleBrief("b1");

        const legs = allocate({
            investable: tr.ledger.balance("surplus.investable"),
            terms: baseTerms(),
            themes: [
                { id: "ai-compute", candidates: [{ asset: NVDA, symbol: "NVDAc", weight: 60 }, { asset: MSFT, symbol: "MSFTc", weight: 40 }] },
                { id: "platform-giants", candidates: [{ asset: META, symbol: "METAc", weight: 145 }, { asset: AMZN, symbol: "AMZNc", weight: 140 }] },
            ],
        }).legs;
        const quoted = new Map([[NVDA, 190_000_000n], [MSFT, 500_000_000n], [META, 600_000_000n], [AMZN, 260_000_000n]]);
        const decimals = new Map([[NVDA, 18], [MSFT, 18], [META, 18], [AMZN, 18]]);

        expect(tr.createProposal({ id: "pr1", legs, quotedPrices: quoted, briefId: "b1" })).toEqual({ ok: true });
        clock.t += 20_000;
        expect(tr.approve("pr1", "owner").ok).toBe(true);
        const done = tr.execute("pr1", { freshPrices: quoted, decimals });
        expect(done.ok).toBe(true);

        const r = backing(tr.ledger.all());
        expect(r.unattributed).toEqual({ usdcIn: 0n, fills: 0 });
        const b = r.briefs[0]!;
        expect(b.briefId).toBe("b1");
        expect(b.simulated).toBe(true);
        expect(b.themes.map((t) => t.theme).sort()).toEqual(["ai-compute", "platform-giants"]);
        // every cent the proposal spent is attributed, and to the theme the leg was allocated under
        expect(b.usdcIn).toBe(legs.reduce((a, l) => a + l.usdcIn, 0n));
        for (const theme of b.themes) {
            const fromLegs = legs.filter((l) => l.theme === theme.theme).reduce((a, l) => a + l.usdcIn, 0n);
            expect(theme.usdcIn).toBe(fromLegs);
        }
    });

    it("leaves a proposal built with no brief unattributed, rather than guessing one", () => {
        const clock = { t: T0, now: () => new Date(clock.t) };
        const mandates = new MandateStore();
        mandates.create(baseTerms(), clock.now());
        const tr = new Treasury({ mode: "sim", mandates, now: clock.now });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "sim", at: clock.now(),
            lines: [{ account: "reserve", amount: u("2.00") }, { account: "equity.opening", amount: u("-2.00") }],
        });
        tr.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
        tr.settleBrief("b1");
        const legs = [{ asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.20"), maxSlippageBps: 100 }];
        const quoted = new Map([[NVDA, 190_000_000n]]);

        tr.createProposal({ id: "pr1", legs, quotedPrices: quoted });
        clock.t += 20_000;
        tr.approve("pr1", "owner");
        tr.execute("pr1", { freshPrices: quoted, decimals: new Map([[NVDA, 18]]) });

        const r = backing(tr.ledger.all());
        expect(r.briefs).toEqual([]);
        expect(r.unattributed).toEqual({ usdcIn: u("0.20"), fills: 1 });
    });
});


describe("what an exit does to the backing", () => {
    /** A sale as the ledger holds it: cost basis out of the position, proceeds back to investable. */
    function sale(
        ledger: Ledger,
        i: { at: number; asset: string; cost: bigint; proceeds: bigint; briefId?: string; theme?: string },
    ): void {
        ledger.post({
            type: "SALE_SETTLED", mode: "sim", at: new Date(i.at),
            idempotencyKey: `sale:${i.asset}:${i.at}`,
            ...(i.briefId !== undefined && { briefId: i.briefId }),
            ...(i.theme !== undefined && { theme: i.theme }),
            lines: [
                { account: `positions.${i.asset}`, amount: -i.cost },
                { account: "surplus.investable", amount: i.proceeds },
                { account: "pnl.realized", amount: -(i.proceeds - i.cost) },
            ],
        });
    }

    it("drops a holding the agent has fully sold rather than showing it at zero", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.10"), briefId: "b1", theme: "ai-compute" });
        fill(ledger, { at: T0 + 1000, asset: MSFT, usdcIn: u("0.07"), briefId: "b1", theme: "ai-compute" });
        sale(ledger, { at: T0 + 2000, asset: NVDA, cost: u("0.10"), proceeds: u("0.13"), briefId: "b1", theme: "ai-compute" });

        const b = backing(ledger.all()).briefs[0]!;
        expect(b.themes[0]!.assets.map((a) => a.asset)).toEqual([MSFT]);
        expect(b.usdcIn).toBe(u("0.07"));
        expect(b.sales).toBe(1);
    });

    it("counts only the part sold when an exit is partial", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.10"), briefId: "b1", theme: "ai-compute" });
        sale(ledger, { at: T0 + 1000, asset: NVDA, cost: u("0.04"), proceeds: u("0.05"), briefId: "b1", theme: "ai-compute" });
        const b = backing(ledger.all()).briefs[0]!;
        expect(b.themes[0]!.assets[0]!.usdcIn).toBe(u("0.06"));
        expect(b.usdcIn).toBe(u("0.06"));
    });

    it("drops a theme whose every position has been closed", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.10"), briefId: "b1", theme: "ai-compute" });
        fill(ledger, { at: T0 + 1, asset: META, usdcIn: u("0.08"), briefId: "b1", theme: "platform-giants" });
        sale(ledger, { at: T0 + 2000, asset: NVDA, cost: u("0.10"), proceeds: u("0.09"), briefId: "b1", theme: "ai-compute" });

        const b = backing(ledger.all()).briefs[0]!;
        expect(b.themes.map((t) => t.theme)).toEqual(["platform-giants"]);
        // a brief standing for ever on a commitment it has unwound would be the dishonest answer
        expect(b.usdcIn).toBe(u("0.08"));
    });

    it("nets an exit out of the unattributed pile too, so the parts still add up", () => {
        const ledger = new Ledger();
        fill(ledger, { at: T0, asset: NVDA, usdcIn: u("0.10") });
        sale(ledger, { at: T0 + 1000, asset: NVDA, cost: u("0.10"), proceeds: u("0.11") });
        const r = backing(ledger.all());
        expect(r.unattributed.usdcIn).toBe(0n);
        expect(r.totalUsdcIn).toBe(0n);
    });
});


describe("an exit of a position built from several commitments", () => {
    it("takes the basis back out of every bucket that put money in", () => {
        // METAc bought under two themes of one brief, plus a demo buy that named neither. One sale of
        // the whole position has to unwind all three, or a brief keeps showing money behind a holding
        // that no longer exists.
        const clock = { t: Date.parse("2026-11-25T09:00:00Z"), now: () => new Date(clock.t) };
        const mandates = new MandateStore();
        mandates.create(baseTerms(), clock.now());
        const tr = new Treasury({ mode: "sim", mandates, now: clock.now });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "sim", at: clock.now(),
            lines: [{ account: "reserve", amount: u("2.00") }, { account: "equity.opening", amount: u("-2.00") }],
        });
        tr.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
        tr.settleBrief("b1");

        const ONE = 10n ** 18n;
        const price = new Map([[META, 100_000_000n]]);
        const decimals = new Map([[META, 18]]);
        const buy = (id: string, theme: string, amount: string, briefId?: string) => {
            tr.createProposal({
                id,
                legs: [{ asset: META, symbol: "METAc", theme, usdcIn: u(amount), maxSlippageBps: 100 }],
                quotedPrices: price,
                ...(briefId !== undefined && { briefId }),
            });
            clock.t += 20_000;
            tr.approve(id, "owner");
            expect(tr.execute(id, { freshPrices: price, decimals }).ok).toBe(true);
        };
        buy("a", "ai-compute", "0.20", "b1");
        buy("b", "platform-giants", "0.10", "b1");
        buy("c", "ai-compute", "0.10"); // a demo buy with no brief

        const before = backing(tr.ledger.all());
        expect(before.briefs[0]!.usdcIn).toBe(u("0.30"));
        expect(before.unattributed.usdcIn).toBe(u("0.10"));

        // sell the whole position at the price it was bought
        const position = positionsFromLedger(tr.ledger.all()).get(META)!;
        const worth = (position.units * 100_000_000n) / ONE;
        tr.createProposal({
            id: "exit",
            legs: [{
                asset: META, symbol: "METAc", theme: "ai-compute", usdcIn: worth,
                maxSlippageBps: 100, side: "sell", unitsIn: position.units,
            }],
            quotedPrices: price,
        });
        clock.t += 20_000;
        tr.approve("exit", "owner");
        expect(tr.execute("exit", { freshPrices: price, decimals }).ok).toBe(true);

        // every bucket is back to nothing, and so is the position
        const after = backing(tr.ledger.all());
        expect(after.briefs).toEqual([]);
        expect(after.unattributed.usdcIn).toBe(0n);
        expect(after.totalUsdcIn).toBe(0n);
        expect(tr.ledger.balance(`positions.${META}`)).toBe(0n);
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });

    it("unwinds a partial exit in proportion to what each bucket put in", () => {
        const clock = { t: Date.parse("2026-11-25T09:00:00Z"), now: () => new Date(clock.t) };
        const mandates = new MandateStore();
        mandates.create(baseTerms(), clock.now());
        const tr = new Treasury({ mode: "sim", mandates, now: clock.now });
        tr.ledger.post({
            type: "OPENING_BALANCE", mode: "sim", at: clock.now(),
            lines: [{ account: "reserve", amount: u("2.00") }, { account: "equity.opening", amount: u("-2.00") }],
        });
        tr.receivePayment({ id: "p1", briefId: "b1", amount: u("3") });
        tr.settleBrief("b1");

        const ONE = 10n ** 18n;
        const price = new Map([[META, 100_000_000n]]);
        const decimals = new Map([[META, 18]]);
        const buy = (id: string, theme: string, amount: string, briefId?: string) => {
            tr.createProposal({
                id,
                legs: [{ asset: META, symbol: "METAc", theme, usdcIn: u(amount), maxSlippageBps: 100 }],
                quotedPrices: price,
                ...(briefId !== undefined && { briefId }),
            });
            clock.t += 20_000;
            tr.approve(id, "owner");
            tr.execute(id, { freshPrices: price, decimals });
        };
        buy("a", "ai-compute", "0.30", "b1");
        buy("b", "platform-giants", "0.10", "b1");

        const position = positionsFromLedger(tr.ledger.all()).get(META)!;
        const half = position.units / 2n;
        const worth = (half * 100_000_000n) / ONE;
        tr.createProposal({
            id: "exit",
            legs: [{
                asset: META, symbol: "METAc", theme: "ai-compute", usdcIn: worth,
                maxSlippageBps: 100, side: "sell", unitsIn: half,
            }],
            quotedPrices: price,
        });
        clock.t += 20_000;
        tr.approve("exit", "owner");
        expect(tr.execute("exit", { freshPrices: price, decimals }).ok).toBe(true);

        // half of each bucket went, not all of the larger one
        const after = backing(tr.ledger.all()).briefs[0]!;
        const ai = after.themes.find((t) => t.theme === "ai-compute")!;
        const pg = after.themes.find((t) => t.theme === "platform-giants")!;
        expect(ai.usdcIn).toBe(u("0.15"));
        expect(pg.usdcIn).toBe(u("0.05"));
        expect(reconcileInternal(tr.ledger).ok).toBe(true);
    });
});
