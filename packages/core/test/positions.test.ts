import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger";
import { costOfUnits, partlyUnrecorded, positionsFromLedger, unsellable, valuePosition } from "../src/positions";
import { parseUsdc as u } from "../src/money";
import { NVDA, MSFT } from "./fixtures";

const T0 = Date.parse("2026-11-25T12:00:00Z");
const ONE = 10n ** 18n; // one whole token at 18 decimals

function buy(l: Ledger, i: { at: number; asset: string; usdcIn: bigint; units: bigint; tx?: string }): void {
    l.post({
        type: "PURCHASE_SETTLED", mode: "sim", at: new Date(i.at), units: i.units,
        idempotencyKey: `buy:${i.asset}:${i.at}`, ...(i.tx !== undefined && { txHash: i.tx }),
        lines: [
            { account: `positions.${i.asset}`, amount: i.usdcIn },
            { account: "surplus.investable", amount: -i.usdcIn },
        ],
    });
}

function sell(l: Ledger, i: { at: number; asset: string; cost: bigint; proceeds: bigint; units: bigint }): void {
    l.post({
        type: "SALE_SETTLED", mode: "sim", at: new Date(i.at), units: -i.units,
        idempotencyKey: `sell:${i.asset}:${i.at}`,
        lines: [
            { account: `positions.${i.asset}`, amount: -i.cost },
            { account: "surplus.investable", amount: i.proceeds },
            { account: "pnl.realized", amount: -(i.proceeds - i.cost) },
        ],
    });
}

describe("what the books say is held", () => {
    it("blends two buys of one token into one position at the average cost", () => {
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.10"), units: ONE });
        buy(l, { at: T0 + 1000, asset: NVDA, usdcIn: u("0.30"), units: ONE });

        const p = positionsFromLedger(l.all()).get(NVDA)!;
        expect(p.units).toBe(2n * ONE);
        expect(p.costUsdcIn).toBe(u("0.40"));
        expect(p.buys).toBe(2);
        expect(p.sells).toBe(0);
        expect(p.realizedUsdc).toBe(0n);
    });

    it("takes a sale's cost basis back out and keeps the gain apart from it", () => {
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.10"), units: ONE });
        sell(l, { at: T0 + 1000, asset: NVDA, cost: u("0.10"), proceeds: u("0.13"), units: ONE });

        const p = positionsFromLedger(l.all()).get(NVDA)!;
        expect(p.units).toBe(0n);
        expect(p.costUsdcIn).toBe(0n);
        expect(p.realizedUsdc).toBe(u("0.03"));
        expect(p.sells).toBe(1);
    });

    it("records a loss as a loss rather than a smaller gain", () => {
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.10"), units: ONE });
        sell(l, { at: T0 + 1000, asset: NVDA, cost: u("0.10"), proceeds: u("0.06"), units: ONE });
        expect(positionsFromLedger(l.all()).get(NVDA)!.realizedUsdc).toBe(u("-0.04"));
    });

    it("keeps two tokens apart", () => {
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.10"), units: ONE });
        buy(l, { at: T0 + 1, asset: MSFT, usdcIn: u("0.20"), units: 2n * ONE });
        const all = positionsFromLedger(l.all());
        expect(all.get(NVDA)!.costUsdcIn).toBe(u("0.10"));
        expect(all.get(MSFT)!.units).toBe(2n * ONE);
    });

    it("refuses an entry with no position line rather than reporting a smaller holding", () => {
        const l = new Ledger();
        l.post({
            type: "PURCHASE_SETTLED", mode: "sim", at: new Date(T0), units: ONE,
            lines: [{ account: "surplus.investable", amount: u("-0.10") }, { account: "cash.operating", amount: u("0.10") }],
        });
        expect(() => positionsFromLedger(l.all())).toThrow(/no positions line/);
    });
});

describe("whether a position can be acted on at all", () => {
    it("refuses to sell a position whose units were never recorded", () => {
        // The state the books were really in before the sell path: eight fills with a cost and no units.
        // Selling "all zero units" of one would book its whole cost as a loss and dispose of nothing.
        const l = new Ledger();
        l.post({
            type: "PURCHASE_SETTLED", mode: "sim", at: new Date(T0),
            lines: [
                { account: `positions.${NVDA}`, amount: u("0.06") },
                { account: "surplus.investable", amount: u("-0.06") },
            ],
        });
        const p = positionsFromLedger(l.all()).get(NVDA)!;
        expect(p.costUsdcIn).toBe(u("0.06"));
        expect(p.units).toBe(0n);
        expect(unsellable(p)).toMatch(/never recorded/);
        expect(valuePosition(p, 100_000_000n, 18)).toBeNull();
    });

    it("says nothing is held once a position is fully sold", () => {
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.10"), units: ONE });
        sell(l, { at: T0 + 1, asset: NVDA, cost: u("0.10"), proceeds: u("0.11"), units: ONE });
        expect(unsellable(positionsFromLedger(l.all()).get(NVDA)!)).toBe("nothing is held");
    });
});

describe("valuing a position against a live price", () => {
    const position = { asset: NVDA, units: 2n * ONE, costUsdcIn: u("0.20"), realizedUsdc: 0n, buys: 1, sells: 0, buysWithoutUnits: 0 };

    it("prices the units held and says how far they have moved", () => {
        // bought at 0.10 a token, now worth 0.13 a token
        const v = valuePosition(position, 130_000n, 18)!;
        expect(v.valueUsdc).toBe(u("0.26"));
        expect(v.moveBps).toBe(3000);
    });

    it("reports a fall as a negative move", () => {
        const v = valuePosition(position, 70_000n, 18)!;
        expect(v.valueUsdc).toBe(u("0.14"));
        expect(v.moveBps).toBe(-3000);
    });

    it("is flat when the price has not moved", () => {
        expect(valuePosition(position, 100_000n, 18)!.moveBps).toBe(0);
    });

    it("refuses a price of zero rather than reporting a total loss", () => {
        expect(valuePosition(position, 0n, 18)).toBeNull();
        expect(valuePosition(position, -1n, 18)).toBeNull();
    });
});

describe("the cost basis of part of a position", () => {
    const position = { asset: NVDA, units: 3n * ONE, costUsdcIn: 100n, realizedUsdc: 0n, buys: 1, sells: 0, buysWithoutUnits: 0 };

    it("takes a share in proportion to the units sold", () => {
        expect(costOfUnits(position, ONE)).toBe(33n);
    });

    it("takes the whole remaining basis on a full exit, leaving no dust behind", () => {
        // 100 / 3 rounds to 33 a third, so three thirds would leave 1 unit of cost on a closed position.
        expect(costOfUnits(position, 3n * ONE)).toBe(100n);
    });

    it("refuses to take the cost of units that are not there", () => {
        expect(() => costOfUnits(position, 4n * ONE)).toThrow(/cannot take the cost/);
        expect(() => costOfUnits(position, 0n)).toThrow(/must be positive/);
    });
});


describe("a sale that lands exactly on its cost basis", () => {
    it("books no profit line at all, and still reconciles", () => {
        // The ledger refuses a zero-amount line, and "sold for what it cost" is an ordinary outcome
        // rather than an error. The entry balances without the line.
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.10"), units: ONE });
        l.post({
            type: "SALE_SETTLED", mode: "sim", at: new Date(T0 + 1000), units: -ONE,
            lines: [
                { account: `positions.${NVDA}`, amount: u("-0.10") },
                { account: "surplus.investable", amount: u("0.10") },
            ],
        });
        const p = positionsFromLedger(l.all()).get(NVDA)!;
        expect(p.units).toBe(0n);
        expect(p.costUsdcIn).toBe(0n);
        expect(p.realizedUsdc).toBe(0n);
    });
});


describe("a position whose history is partly unrecorded", () => {
    it("can be sold, but says what the gain or loss would actually mean", () => {
        // The real shape of these books: an early fill with a cost and no units, then a later one with
        // both. The units are real; the cost basis covers more than them.
        const l = new Ledger();
        l.post({
            type: "PURCHASE_SETTLED", mode: "sim", at: new Date(T0),
            lines: [
                { account: `positions.${NVDA}`, amount: u("0.13") },
                { account: "surplus.investable", amount: u("-0.13") },
            ],
        });
        buy(l, { at: T0 + 1000, asset: NVDA, usdcIn: u("0.07"), units: ONE });

        const p = positionsFromLedger(l.all()).get(NVDA)!;
        expect(p.buys).toBe(2);
        expect(p.buysWithoutUnits).toBe(1);
        expect(p.units).toBe(ONE);
        expect(p.costUsdcIn).toBe(u("0.20"));
        // sellable, because the units it reports are real
        expect(unsellable(p)).toBeNull();
        // but what a sale would realize is a write-off, and it says so
        expect(partlyUnrecorded(p)).toMatch(/1 of 2 buys recorded no units/);
        expect(partlyUnrecorded(p)).toMatch(/not a market move/);
    });

    it("says nothing when every buy recorded its units", () => {
        const l = new Ledger();
        buy(l, { at: T0, asset: NVDA, usdcIn: u("0.07"), units: ONE });
        expect(partlyUnrecorded(positionsFromLedger(l.all()).get(NVDA)!)).toBeNull();
    });
});
