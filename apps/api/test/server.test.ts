import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { parseUsdc as u, BASE_REGISTRY, JsonlLedgerStore, flushNewEntries, Ledger, MandateStore, type MandateTerms, type SavedBrief, type Brief } from "@surplus/core";
import { buildServer, bookSettlement, salesFromLedger, BRIEF_ROUTE, type BookedSale } from "../src/server";
import { loadConfig, USDC, BASE_SEPOLIA } from "../src/config";

const PAY_TO = "0x" + "a".repeat(40);
const config = loadConfig({ X402_PAY_TO: PAY_TO, BRIEF_PRICE_USD: "$3.00", OWNER_TOKEN: "owner-token-for-tests-only", OWNER_ADDRESS: "0x" + "9".repeat(40) } as NodeJS.ProcessEnv);
const ASSET = USDC[BASE_SEPOLIA]!;

const terms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [{ id: "ai-compute", targetBps: 10000 }],
    maxCompanyBps: 4000,
    investShareBps: 5000,
    maxTradeUsdc: u("1.00"),
    minTradeUsdc: u("0.05"),
    reserveTargetUsdc: u("2.00"),
    maxSlippageBps: 100,
    driftToleranceBps: 100,
    approvalExpirySeconds: 600,
};

/** A mandate store holding exactly these terms, as the server and engine now share one. */
function mandateFor(t: MandateTerms): MandateStore {
    const m = new MandateStore();
    m.create(t);
    return m;
}


const brief: Brief = {
    id: "brief-test",
    createdAt: "2026-11-21T00:00:00.000Z",
    sources: [],
    themes: [],
    disclaimer: "Informational only, not investment advice.",
};
const saved: SavedBrief = {
    file: "brief-test.json",
    provider: "gemini",
    model: "test-model",
    brief,
    costUsdcMinor: 21188n,
    costUsd: 0.0212,
};
const build = () => buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved });

const facts = (over: Partial<Parameters<typeof bookSettlement>[0]["facts"]> = {}) => ({
    success: true,
    transaction: "0xdeadbeef",
    payer: "0x" + "b".repeat(40),
    requiredAmount: "3000000",
    asset: ASSET,
    ...over,
});

describe("the paid endpoint", () => {
    it("answers /health for free and says what it sells", async () => {
        const { app } = build();
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.network).toBe(BASE_SEPOLIA);
        expect(res.body.mode).toBe("testnet");
        expect(res.body.price).toBe("$3.00");
        expect(res.body.payTo).toBe(PAY_TO);
        expect(res.body.latestBrief).toBe("brief-test");
    });

    it("demands payment for the brief and does not leak it in the 402", async () => {
        const { app } = build();
        const res = await request(app).get(BRIEF_ROUTE);
        expect(res.status).toBe(402);
        expect(JSON.stringify(res.body)).not.toContain("not investment advice");
    });

    it("books nothing until a payment settles", async () => {
        const { app, treasury } = build();
        await request(app).get(BRIEF_ROUTE);
        expect(treasury.ledger.all().length).toBe(0);
    });
});

describe("bookSettlement", () => {
    const setup = () => {
        const { treasury } = build();
        const sales: BookedSale[] = [];
        return { treasury, sales };
    };

    it("books a settled payment as revenue, once per transaction", () => {
        const { treasury, sales } = setup();
        const args = { treasury, sales, expectedAsset: ASSET, briefId: brief.id, facts: facts() };
        expect(bookSettlement(args)).toBe("booked");
        expect(bookSettlement(args)).toBe("booked"); // a replay must not double count
        expect(sales.length).toBe(1);
        expect(treasury.ledger.balance("cash.operating")).toBe(u("3.00"));
        expect(treasury.ledger.all().filter((e) => e.type === "PAYMENT_RECEIVED").length).toBe(1);
        expect(treasury.ledger.all()[0]!.mode).toBe("testnet");
        expect(treasury.ledger.all()[0]!.txHash).toBe("0xdeadbeef");
    });

    it("prefers the actually settled amount over the required amount", () => {
        const { treasury, sales } = setup();
        const v = bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id,
            facts: facts({ amount: "2500000" }),
        });
        expect(v).toBe("booked");
        expect(treasury.ledger.balance("cash.operating")).toBe(u("2.50"));
    });

    it("refuses to count another token's atomic units as USDC", () => {
        const { treasury, sales } = setup();
        const v = bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id,
            facts: facts({ asset: "0x" + "c".repeat(40) }),
        });
        expect(v).toBe("wrong_asset");
        expect(treasury.ledger.all().length).toBe(0);
        expect(sales.length).toBe(0);
    });

    it("books nothing for an unsuccessful or zero settlement", () => {
        const { treasury, sales } = setup();
        expect(bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id, facts: facts({ success: false }),
        })).toBe("not_settled");
        expect(bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id, facts: facts({ requiredAmount: "0" }),
        })).toBe("zero_amount");
        expect(treasury.ledger.all().length).toBe(0);
    });

    it("matches the asset case-insensitively", () => {
        const { treasury, sales } = setup();
        const v = bookSettlement({
            treasury, sales, expectedAsset: ASSET.toUpperCase().replace("0X", "0x"),
            briefId: brief.id, facts: facts({ asset: ASSET.toLowerCase() }),
        });
        expect(v).toBe("booked");
    });
});

describe("persistence", () => {
    let dir: string;
    let store: JsonlLedgerStore;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "surplus-api-"));
        store = new JsonlLedgerStore(join(dir, "ledger.jsonl"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const bookOne = (tx: string) => {
        const built = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, store });
        const verdict = bookSettlement({
            treasury: built.treasury,
            sales: built.sales,
            expectedAsset: ASSET,
            briefId: brief.id,
            facts: facts({ transaction: tx, requiredAmount: "10000" }),
        });
        return { built, verdict };
    };

    it("survives a restart: balances, sales and the brief sold all come back", () => {
        const first = bookOne("0xaaa");
        expect(first.verdict).toBe("booked");
        // the server flushes inside the settle hook, so flush here the way the hook does
        flushNewEntries(first.built.treasury.ledger, store, 0);

        const restarted = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, store });
        expect(restarted.treasury.ledger.balance("cash.operating")).toBe(u("0.01"));
        expect(restarted.sales.length).toBe(1);
        expect(restarted.sales[0]!.transaction).toBe("0xaaa");
        expect(restarted.sales[0]!.briefId).toBe(brief.id);
        expect(restarted.treasury.ledger.all()[0]!.txHash).toBe("0xaaa");
    });

    it("refuses to book the same settlement again after a restart", () => {
        const first = bookOne("0xaaa");
        flushNewEntries(first.built.treasury.ledger, store, 0);

        const restarted = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, store });
        const again = bookSettlement({
            treasury: restarted.treasury,
            sales: restarted.sales,
            expectedAsset: ASSET,
            briefId: brief.id,
            facts: facts({ transaction: "0xaaa", requiredAmount: "10000" }),
        });
        expect(again).toBe("booked"); // idempotent, not an error
        expect(restarted.treasury.ledger.all().filter((e) => e.type === "PAYMENT_RECEIVED").length).toBe(1);
        expect(restarted.treasury.ledger.balance("cash.operating")).toBe(u("0.01"));
        expect(restarted.sales.length).toBe(1);
    });

    it("starts clean when there is no ledger file yet", () => {
        const built = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, store });
        expect(built.treasury.ledger.all()).toEqual([]);
        expect(built.sales).toEqual([]);
    });

    it("works with no store at all, keeping everything in memory", () => {
        const built = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved });
        expect(built.sales).toEqual([]);
        expect(existsSync(join(dir, "ledger.jsonl"))).toBe(false);
    });
});

describe("salesFromLedger", () => {
    it("ignores entries that are not booked sales", () => {
        const l = new Ledger();
        l.post({ type: "REFUSAL", mode: "testnet", at: new Date("2026-11-21T00:00:00Z"), lines: [], memo: "nope" });
        l.post({
            type: "COST_ACCRUED", mode: "testnet", at: new Date("2026-11-21T00:00:01Z"),
            lines: [{ account: "expense.llm", amount: u("0.02") }, { account: "cash.operating", amount: u("-0.02") }],
        });
        expect(salesFromLedger(l.all())).toEqual([]);
    });
});
