import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
    parseUsdc as u, BASE_REGISTRY, JsonlLedgerStore, flushNewEntries, openLedger, Ledger, MandateStore,
    type MandateTerms, type SavedBrief, type Brief,
} from "@surplus/core";
import { buildServer, bookSettlement, salesFromLedger, BRIEF_ROUTE, type BookedSale } from "../src/server";
import { UNATTRIBUTED } from "../src/investing";
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

    it("books a settled payment as revenue, once per transaction", async () => {
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

    it("prefers the actually settled amount over the required amount", async () => {
        const { treasury, sales } = setup();
        const v = bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id,
            facts: facts({ amount: "2500000" }),
        });
        expect(v).toBe("booked");
        expect(treasury.ledger.balance("cash.operating")).toBe(u("2.50"));
    });

    it("refuses to count another token's atomic units as USDC", async () => {
        const { treasury, sales } = setup();
        const v = bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id,
            facts: facts({ asset: "0x" + "c".repeat(40) }),
        });
        expect(v).toBe("wrong_asset");
        expect(treasury.ledger.all().length).toBe(0);
        expect(sales.length).toBe(0);
    });

    it("books nothing for an unsuccessful or zero settlement", async () => {
        const { treasury, sales } = setup();
        expect(bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id, facts: facts({ success: false }),
        })).toBe("not_settled");
        expect(bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: brief.id, facts: facts({ requiredAmount: "0" }),
        })).toBe("zero_amount");
        expect(treasury.ledger.all().length).toBe(0);
    });

    it("matches the asset case-insensitively", async () => {
        const { treasury, sales } = setup();
        const v = bookSettlement({
            treasury, sales, expectedAsset: ASSET.toUpperCase().replace("0X", "0x"),
            briefId: brief.id, facts: facts({ asset: ASSET.toLowerCase() }),
        });
        expect(v).toBe("booked");
    });
});

describe("what /health reports", () => {
    it("names the storage that is live, because the wrong one does not announce itself", async () => {
        const withDb = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, storage: "postgres" });
        const res = await request(withDb.app).get("/health");
        expect(res.body.storage).toBe("postgres");

        const withFiles = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, storage: "files" });
        expect((await request(withFiles.app).get("/health")).body.storage).toBe("files");

        // a server built with no storage at all says so rather than claiming one
        const neither = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved });
        expect((await request(neither.app).get("/health")).body.storage).toBe("none");
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

    const bookOne = async (tx: string) => {
        const built = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, ledger: await openLedger(store), sink: store });
        const verdict = bookSettlement({
            treasury: built.treasury,
            sales: built.sales,
            expectedAsset: ASSET,
            briefId: brief.id,
            facts: facts({ transaction: tx, requiredAmount: "10000" }),
        });
        return { built, verdict };
    };

    it("survives a restart: balances, sales and the brief sold all come back", async () => {
        const first = await bookOne("0xaaa");
        expect(first.verdict).toBe("booked");
        // the server flushes inside the settle hook, so flush here the way the hook does
        await flushNewEntries(first.built.treasury.ledger, store, 0);

        const restarted = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, ledger: await openLedger(store), sink: store });
        expect(restarted.treasury.ledger.balance("cash.operating")).toBe(u("0.01"));
        expect(restarted.sales.length).toBe(1);
        expect(restarted.sales[0]!.transaction).toBe("0xaaa");
        expect(restarted.sales[0]!.briefId).toBe(brief.id);
        expect(restarted.treasury.ledger.all()[0]!.txHash).toBe("0xaaa");
    });

    it("refuses to book the same settlement again after a restart", async () => {
        const first = await bookOne("0xaaa");
        await flushNewEntries(first.built.treasury.ledger, store, 0);

        const restarted = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, ledger: await openLedger(store), sink: store });
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

    it("starts clean when there is no ledger file yet", async () => {
        const built = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved, ledger: await openLedger(store), sink: store });
        expect(built.treasury.ledger.all()).toEqual([]);
        expect(built.sales).toEqual([]);
    });

    it("works with no store at all, keeping everything in memory", async () => {
        const built = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved });
        expect(built.sales).toEqual([]);
        expect(existsSync(join(dir, "ledger.jsonl"))).toBe(false);
    });
});

describe("salesFromLedger", () => {
    it("ignores entries that are not booked sales", async () => {
        const l = new Ledger();
        l.post({ type: "REFUSAL", mode: "testnet", at: new Date("2026-11-21T00:00:00Z"), lines: [], memo: "nope" });
        l.post({
            type: "COST_ACCRUED", mode: "testnet", at: new Date("2026-11-21T00:00:01Z"),
            lines: [{ account: "expense.llm", amount: u("0.02") }, { account: "cash.operating", amount: u("-0.02") }],
        });
        expect(salesFromLedger(l.all())).toEqual([]);
    });
});

describe("M1 regression: attribution never guesses", () => {
    it("falls back to unattributed rather than to the newest brief", async () => {
        // outside a request there is no served-brief context, which is exactly the case where the old
        // code reached for `readBrief()` and attributed the sale to a brief nobody bought
        const { treasury } = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved });
        const sales: BookedSale[] = [];
        const verdict = bookSettlement({
            treasury, sales, expectedAsset: ASSET, briefId: UNATTRIBUTED,
            facts: facts({ requiredAmount: "10000" }),
        });
        expect(verdict).toBe("booked");
        expect(treasury.ledger.all()[0]!.briefId).toBe(UNATTRIBUTED);
        expect(treasury.ledger.all()[0]!.briefId).not.toBe(saved.brief.id);
    });
});

describe("L4/L5 regression: ledger exposure and id validation", () => {
    const TOK = "owner-token-for-tests-only";
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${TOK}`);

    it("keeps the sales ledger owner-only by default", async () => {
        const { app } = buildServer({ config, mandates: mandateFor(terms), readBrief: () => saved });
        expect((await request(app).get("/ledger")).status).toBe(401);
        expect((await auth(request(app).get("/ledger"))).status).toBe(200);
    });

    it("publishes the ledger when the operator opts in", async () => {
        const open = loadConfig({
            X402_PAY_TO: PAY_TO, OWNER_TOKEN: TOK, OWNER_ADDRESS: "0x" + "9".repeat(40),
            PUBLIC_LEDGER: "true",
        } as NodeJS.ProcessEnv);
        const { app } = buildServer({ config: open, mandates: mandateFor(terms), readBrief: () => saved });
        expect((await request(app).get("/ledger")).status).toBe(200);
        const health = await request(app).get("/health");
        expect(health.body.ledgerPublic).toBe(true);
    });
});
