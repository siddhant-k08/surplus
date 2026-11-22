import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
    parseUsdc as u, BASE_REGISTRY, JsonlLedgerStore, flushNewEntries, openLedger, Ledger, MandateStore,
    type MandateTerms, type SavedBrief, type Brief,
} from "@surplus/core";
import { buildServer, bookSettlement, persistSale, salesFromLedger, BRIEF_ROUTE, type BookedSale } from "../src/server";
import { JsonlReceiptStore } from "../src/receipts";
import { vi } from "vitest";
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

describe("writing a settled sale down", () => {
    const tx = "0x" + "fe".repeat(32);
    const served = { briefId: "brief-test", source: "catalogue" as const, receiptId: "r".repeat(32) };

    it("stores the receipt and the ledger entry, and reports the new high-water mark", async () => {
        const dir = mkdtempSync(join(tmpdir(), "surplus-persist-"));
        try {
            const store = new JsonlLedgerStore(join(dir, "ledger.jsonl"));
            const receipts = new JsonlReceiptStore(join(dir, "receipts.jsonl"));
            const ledger = new Ledger();
            ledger.post({
                type: "PAYMENT_RECEIVED", mode: "testnet", at: new Date("2026-11-22T00:00:00Z"),
                idempotencyKey: `x402:${tx}`, txHash: tx, briefId: "brief-test",
                lines: [
                    { account: "cash.operating", amount: u("0.01") },
                    { account: "revenue.research", amount: u("-0.01") },
                ],
            });

            const mark = await persistSale({
                receipts, sink: store, ledger, persistedId: 0, served,
                transaction: tx, amountUsdcMinor: u("0.01"), payer: "0x" + "b".repeat(40),
            });
            expect(mark).toBe(1);
            expect((await store.load()).length).toBe(1);
            expect((await receipts.find(served.receiptId))?.payer).toBe("0x" + "b".repeat(40));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("never throws when storage fails, and says exactly what to reconcile", async () => {
        // The money has already moved onchain. Throwing here would fail the settlement closed, telling
        // the buyer their payment failed when they have been charged, and they would not get the brief
        // either. The sale must instead be recoverable by hand from the log.
        const errors: string[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            errors.push(args.map((a) => (typeof a === "string" ? a : "")).join(" "));
        });
        try {
            const ledger = new Ledger();
            ledger.post({
                type: "PAYMENT_RECEIVED", mode: "testnet", at: new Date("2026-11-22T00:00:00Z"),
                idempotencyKey: `x402:${tx}`, txHash: tx, briefId: "brief-test",
                lines: [
                    { account: "cash.operating", amount: u("0.01") },
                    { account: "revenue.research", amount: u("-0.01") },
                ],
            });
            const broken = {
                load: async () => [],
                append: async () => { throw new Error("the database is unreachable"); },
            };
            const mark = await persistSale({
                sink: broken, ledger, persistedId: 0, served,
                transaction: tx, amountUsdcMinor: u("0.01"), payer: "0x" + "b".repeat(40),
            });
            expect(mark).toBe(0); // unchanged: nothing was persisted
            // one line of JSON, so a log drain can alert on the event rather than on a phrase
            const line = JSON.parse(errors[0]!) as Record<string, unknown>;
            expect(line.event).toBe("sale_not_recorded");
            expect(line.level).toBe("error");
            // the transaction is the whole point of the line: it must survive redaction intact
            expect(line.transaction).toBe(tx);
            expect(line.briefId).toBe("brief-test");
            expect(line.receiptId).toBe(served.receiptId);
            expect(line.amountUsdcMinor).toBe("10000");
        } finally {
            spy.mockRestore();
        }
    });

    it("still records the ledger entry when only the receipt store fails", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const dir = mkdtempSync(join(tmpdir(), "surplus-persist-"));
            const store = new JsonlLedgerStore(join(dir, "ledger.jsonl"));
            const ledger = new Ledger();
            ledger.post({
                type: "PAYMENT_RECEIVED", mode: "testnet", at: new Date("2026-11-22T00:00:00Z"),
                idempotencyKey: `x402:${tx}`, txHash: tx, briefId: "brief-test",
                lines: [
                    { account: "cash.operating", amount: u("0.01") },
                    { account: "revenue.research", amount: u("-0.01") },
                ],
            });
            const brokenReceipts = {
                issue: async () => { throw new Error("receipts are unreachable"); },
                find: async () => null,
                forTransaction: async () => null,
                forPayer: async () => [],
                count: async () => 0,
            };
            // the receipt is the buyer's convenience; the ledger is the money, and this reports the
            // failure rather than pretending either happened
            const mark = await persistSale({
                receipts: brokenReceipts, sink: store, ledger, persistedId: 0, served,
                transaction: tx, amountUsdcMinor: u("0.01"),
            });
            expect(mark).toBe(0);
            expect(spy).toHaveBeenCalled();
            rmSync(dir, { recursive: true, force: true });
        } finally {
            spy.mockRestore();
        }
    });
});

describe("when a handler throws", () => {
    it("does not leak the reason a route failed", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const dying = {
                issue: async (): Promise<void> => {},
                find: async (): Promise<never> => { throw new Error("DATABASE_URL points at a dead host"); },
                forTransaction: async () => null,
                forPayer: async () => [],
                count: async () => 0,
            };
            const { app } = buildServer({
                config, mandates: mandateFor(terms), readBrief: () => saved,
                receipts: dying, storageCheck: async () => ({ ok: true }),
            });
            const res = await request(app).get(`/receipt/${"a".repeat(32)}`);
            expect(res.status).toBe(500);
            expect(res.body).toEqual({ error: "the agent could not complete that request" });
            expect(res.text).not.toContain("DATABASE_URL");
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});

describe("what /health reports", () => {
    it("fails the check when storage has gone away since start-up", async () => {
        // a process that started fine and has since lost its database still answers every route; this
        // is the state a monitor has to be able to catch
        const down = buildServer({
            config, mandates: mandateFor(terms), readBrief: () => saved, storage: "postgres",
            storageCheck: async () => ({ ok: false, detail: "connection terminated" }),
        });
        const res = await request(down.app).get("/health");
        expect(res.status).toBe(503);
        expect(res.body.ok).toBe(false);
        expect(res.body.checks.storage).toBe("unreachable");
        expect(res.body.checks.storageDetail).toBe("connection terminated");
    });

    it("passes when storage answers and the books reconcile", async () => {
        const up = buildServer({
            config, mandates: mandateFor(terms), readBrief: () => saved, storage: "postgres",
            storageCheck: async () => ({ ok: true }),
        });
        const res = await request(up.app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.checks).toMatchObject({ storage: "ok", books: "reconciled", catalogue: "ok" });
    });

    it("reports an empty catalogue without calling itself unhealthy", async () => {
        // a new deployment has nothing to sell until the first brief is written; that is not a fault
        const bare = buildServer({
            config, mandates: mandateFor(terms),
            readBrief: () => { throw new Error("no briefs yet"); },
            storageCheck: async () => ({ ok: true }),
        });
        const res = await request(bare.app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body.checks.catalogue).toBe("empty");
        expect(res.body.latestBrief).toBe(null);
    });

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
