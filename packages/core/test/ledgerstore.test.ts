import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { flushNewEntries } from "../src/storage";
import {
    JsonlLedgerStore,
    parseLedgerFile,
    parseTxLine,
    realizedRevenue,
    realizedSales,
    serializeTx,
} from "../src/ledgerstore";
import { parseUsdc as u } from "../src/money";

let dir: string;
let path: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "surplus-ledger-"));
    path = join(dir, "nested", "ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sale = (at: Date, tx: string) => ({
    type: "PAYMENT_RECEIVED" as const,
    mode: "testnet" as const,
    at,
    idempotencyKey: `x402:${tx}`,
    txHash: tx,
    memo: "x402 sale",
    lines: [
        { account: "cash.operating" as const, amount: u("0.01") },
        { account: "revenue.research" as const, amount: u("-0.01") },
    ],
});

describe("JsonlLedgerStore", () => {
    it("round-trips a ledger through disk with every field and balance intact", async () => {
        const l = new Ledger();
        l.post(sale(new Date("2026-11-21T00:00:00Z"), "0xaaa"));
        l.post({
            type: "COST_ACCRUED", mode: "testnet", at: new Date("2026-11-21T00:00:01Z"), memo: "metered",
            lines: [
                { account: "expense.llm", amount: u("0.021188") },
                { account: "cash.operating", amount: u("-0.021188") },
            ],
        });

        const store = new JsonlLedgerStore(path);
        await store.append(l.all());
        const back = store.loadLedger();

        expect(back.all()).toEqual(l.all());
        expect([...back.balances()]).toEqual([...l.balances()]);
        expect(back.all()[0]!.txHash).toBe("0xaaa");
        expect(back.balance("cash.operating")).toBe(u("0.01") - u("0.021188"));
    });

    it("stores amounts as strings so money never passes through a float", () => {
        const l = new Ledger();
        l.post(sale(new Date("2026-11-21T00:00:00Z"), "0xaaa"));
        const line = serializeTx(l.all()[0]!);
        expect(line).toContain('"amount":"10000"');
        expect(JSON.parse(line).lines[0].amount).toBe("10000");
    });

    it("a ledger reloaded from disk refuses the same settlement twice", async () => {
        const l = new Ledger();
        const s = sale(new Date("2026-11-21T00:00:00Z"), "0xaaa");
        l.post(s);
        const store = new JsonlLedgerStore(path);
        await store.append(l.all());

        const back = store.loadLedger();
        back.post(s); // the facilitator replays the settlement after a restart
        expect(back.all().length).toBe(1);
        expect(back.balance("cash.operating")).toBe(u("0.01"));
    });

    it("round-trips an event entry that moves no money", async () => {
        // Treasury records REFUSAL and PROPOSAL_CREATED as entries with no lines
        const l = new Ledger();
        l.post({ type: "REFUSAL", mode: "testnet", at: new Date("2026-11-21T00:00:00Z"), lines: [], memo: "quote too old" });
        const store = new JsonlLedgerStore(path);
        await store.append(l.all());
        const back = store.loadLedger();
        expect(back.all()).toEqual(l.all());
        expect(back.all()[0]!.memo).toBe("quote too old");
    });

    it("treats a missing file as an empty ledger", async () => {
        const store = new JsonlLedgerStore(join(dir, "none.jsonl"));
        expect(await store.load()).toEqual([]);
        expect(store.loadLedger().all()).toEqual([]);
    });

    it("appends only what is new and reports the high-water mark", async () => {
        const l = new Ledger();
        const store = new JsonlLedgerStore(path);
        l.post(sale(new Date("2026-11-21T00:00:00Z"), "0xaaa"));
        let mark = await flushNewEntries(l, store, 0);
        expect(mark).toBe(1);

        mark = await flushNewEntries(l, store, mark); // nothing new
        expect(mark).toBe(1);
        expect((await store.load()).length).toBe(1);

        l.post(sale(new Date("2026-11-21T00:00:02Z"), "0xbbb"));
        mark = await flushNewEntries(l, store, mark);
        expect(mark).toBe(2);
        expect((await store.load()).length).toBe(2);
        expect(readFileSync(path, "utf8").trimEnd().split("\n").length).toBe(2);
    });
});

describe("reading the ledger file back", () => {
    it("rejects a truncated last line instead of dropping it", () => {
        const l = new Ledger();
        l.post(sale(new Date("2026-11-21T00:00:00Z"), "0xaaa"));
        const good = serializeTx(l.all()[0]!);
        writeFileSync(path.replace("nested/", ""), good + "\n" + good.slice(0, 40));
        expect(() => parseLedgerFile(readFileSync(path.replace("nested/", ""), "utf8"), "f")).toThrow(/truncated|valid JSON/);
    });

    it("rejects a float amount", () => {
        expect(() => parseTxLine(
            JSON.stringify({ id: 1, at: "2026-11-21T00:00:00.000Z", type: "PAYMENT_RECEIVED", mode: "testnet", lines: [{ account: "cash.operating", amount: 0.01 }] }),
            "f",
        )).toThrow(/decimal string of minor units/);
    });

    it("rejects an unknown type or mode", () => {
        const base = { id: 1, at: "2026-11-21T00:00:00.000Z", lines: [{ account: "cash.operating", amount: "1" }] };
        expect(() => parseTxLine(JSON.stringify({ ...base, type: "WIRE", mode: "testnet" }), "f")).toThrow(/unknown type/);
        expect(() => parseTxLine(JSON.stringify({ ...base, type: "PAYMENT_RECEIVED", mode: "prod" }), "f")).toThrow(/unknown mode/);
    });

    it("notices a gap in the entry ids", () => {
        const mk = (id: number) => JSON.stringify({
            id, at: "2026-11-21T00:00:00.000Z", type: "PAYMENT_RECEIVED", mode: "testnet",
            lines: [{ account: "cash.operating", amount: "1" }, { account: "revenue.research", amount: "-1" }],
        });
        expect(() => parseLedgerFile(`${mk(1)}\n${mk(3)}\n`, "f")).toThrow(/ids jump from 1 to 3/);
    });
});

describe("what the ledger proves was earned", () => {
    const mk = (l: Ledger) => {
        l.post({
            type: "PAYMENT_RECEIVED", mode: "testnet", at: new Date("2026-11-21T00:00:00Z"),
            idempotencyKey: "pay:a", txHash: "0xaaa", briefId: "brief-1",
            lines: [{ account: "cash.operating", amount: u("0.01") }, { account: "revenue.research", amount: u("-0.01") }],
        });
        l.post({
            type: "PAYMENT_RECEIVED", mode: "testnet", at: new Date("2026-11-21T00:00:01Z"),
            idempotencyKey: "pay:b", txHash: "0xbbb", briefId: "brief-1",
            lines: [{ account: "cash.operating", amount: u("0.01") }, { account: "revenue.research", amount: u("-0.01") }],
        });
        return l;
    };

    it("totals the sales and keeps their transactions, briefs and mode", () => {
        const l = mk(new Ledger());
        const sales = realizedSales(l.all());
        expect(sales.length).toBe(2);
        expect(sales.map((s) => s.transaction)).toEqual(["0xaaa", "0xbbb"]);
        expect(sales[0]!.briefId).toBe("brief-1");
        expect(sales[0]!.mode).toBe("testnet");
        expect(realizedRevenue(l.all())).toBe(u("0.02"));
    });

    it("ignores a payment with no settlement transaction", () => {
        // a payment the agent recorded but that never landed onchain is not proven revenue
        const l = new Ledger();
        l.post({
            type: "PAYMENT_RECEIVED", mode: "sim", at: new Date("2026-11-21T00:00:00Z"), idempotencyKey: "pay:sim",
            lines: [{ account: "cash.operating", amount: u("3") }, { account: "revenue.research", amount: u("-3") }],
        });
        expect(realizedSales(l.all())).toEqual([]);
        expect(realizedRevenue(l.all())).toBe(0n);
    });

    it("ignores costs and other entry types", () => {
        const l = mk(new Ledger());
        l.post({
            type: "COST_ACCRUED", mode: "testnet", at: new Date("2026-11-21T00:00:02Z"), briefId: "brief-1",
            lines: [{ account: "expense.llm", amount: u("0.02") }, { account: "cash.operating", amount: u("-0.02") }],
        });
        expect(realizedRevenue(l.all())).toBe(u("0.02")); // unchanged by the cost
    });

    it("survives a round trip through the file", async () => {
        const l = mk(new Ledger());
        const store = new JsonlLedgerStore(path);
        await store.append(l.all());
        expect(realizedRevenue(await store.load())).toBe(u("0.02"));
        expect(realizedSales(await store.load())[0]!.briefId).toBe("brief-1");
    });
});
