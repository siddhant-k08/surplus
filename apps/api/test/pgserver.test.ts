import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import {
    parseUsdc as u, BASE_REGISTRY, flushNewEntries, openLedger, openMandateFrom,
    type MandateTerms, type SavedBrief, type Brief,
} from "@surplus/core";
import { buildServer, bookSettlement } from "../src/server";
import { loadConfig, USDC, BASE_SEPOLIA } from "../src/config";
import { pgBackends } from "../src/backends";
import { newReceiptId } from "../src/receipts";
import { scratchSchema, hasDatabase, type Scratch } from "./pghelp";

/**
 * The whole server on Postgres, restarted.
 *
 * This is the case the change exists for: on a host that can replace the process between two requests,
 * a settlement written by one instance has to be there for the next. The test takes a payment, throws
 * the server away, builds a new one against the same database, and checks that the money, the sale, the
 * brief it was attributed to, the receipt and the mandate all came back, and that replaying the same
 * settlement books nothing twice.
 */
const describeDb = hasDatabase ? describe : describe.skip;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const PAY_TO = "0x" + "a".repeat(40);
const config = loadConfig({
    X402_PAY_TO: PAY_TO,
    BRIEF_PRICE_USD: "$3.00",
    OWNER_TOKEN: "owner-token-for-tests-only",
    OWNER_ADDRESS: "0x" + "9".repeat(40),
} as NodeJS.ProcessEnv);
const ASSET = USDC[BASE_SEPOLIA]!;

const terms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [{ id: "ai-compute", targetBps: 10_000 }],
    maxCompanyBps: 4000,
    investShareBps: 5000,
    maxTradeUsdc: u("1.00"),
    minTradeUsdc: u("0.05"),
    reserveTargetUsdc: u("2.00"),
    maxSlippageBps: 100,
    driftToleranceBps: 100,
    approvalExpirySeconds: 600,
};

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
    costUsdcMinor: 21_188n,
    costUsd: 0.0212,
};

const facts = (tx: string) => ({
    success: true,
    transaction: tx,
    payer: "0x" + "b".repeat(40),
    requiredAmount: "10000",
    asset: ASSET,
});

/** A server wired to Postgres the way index.ts wires it, built fresh each time. */
async function boot(scratch: Scratch) {
    const backends = pgBackends(config, scratch.sql);
    const { mandates } = await openMandateFrom(backends.mandate, terms);
    const built = buildServer({
        config,
        mandates,
        ledger: await openLedger(backends.sales),
        sink: backends.sales,
        receipts: backends.receipts,
        sessions: backends.sessions,
        readBrief: () => saved,
        findBrief: (id) => (id === brief.id ? saved : null),
        updateMandate: async (next) => {
            const created = mandates.create(next);
            await backends.mandate.append(created);
            return created;
        },
    });
    return { ...built, backends, mandates };
}

describeDb("the server on Postgres, across a restart", () => {
    it("brings back the money, the sale, the receipt and the mandate", async () => {
        const scratch = await scratchSchema();
        try {
            const first = await boot(scratch);
            const receiptId = newReceiptId();
            const verdict = bookSettlement({
                treasury: first.treasury,
                sales: first.sales,
                expectedAsset: ASSET,
                briefId: brief.id,
                facts: facts("0xaaa"),
            });
            expect(verdict).toBe("booked");
            await flushNewEntries(first.treasury.ledger, first.backends.sales, 0);
            await first.backends.receipts.issue({
                id: receiptId,
                briefId: brief.id,
                source: "catalogue",
                transaction: "0xaaa",
                amountUsdcMinor: "10000",
                at: new Date().toISOString(),
            });
            expect(first.mandates.current().version).toBe(1);

            // the process is replaced; nothing is carried over but the database
            const second = await boot(scratch);
            expect(second.treasury.ledger.balance("cash.operating")).toBe(u("0.01"));
            expect(second.sales.length).toBe(1);
            expect(second.sales[0]!.transaction).toBe("0xaaa");
            expect(second.sales[0]!.briefId).toBe(brief.id);
            expect(second.mandates.current().version).toBe(1);

            // the buyer's link still works, on an instance that never saw the purchase
            const res = await request(second.app).get(`/receipt/${receiptId}`);
            expect(res.status).toBe(200);
            expect(res.body.brief.id).toBe(brief.id);
            expect(res.body.receipt.transaction).toBe("0xaaa");
        } finally {
            await scratch.drop();
        }
    });

    it("refuses to book the same settlement twice after a restart", async () => {
        const scratch = await scratchSchema();
        try {
            const first = await boot(scratch);
            bookSettlement({
                treasury: first.treasury, sales: first.sales, expectedAsset: ASSET,
                briefId: brief.id, facts: facts("0xbbb"),
            });
            await flushNewEntries(first.treasury.ledger, first.backends.sales, 0);

            const second = await boot(scratch);
            const again = bookSettlement({
                treasury: second.treasury, sales: second.sales, expectedAsset: ASSET,
                briefId: brief.id, facts: facts("0xbbb"),
            });
            expect(again).toBe("booked"); // idempotent, not an error
            await flushNewEntries(second.treasury.ledger, second.backends.sales, 0);

            const third = await boot(scratch);
            expect(third.treasury.ledger.all().filter((e) => e.type === "PAYMENT_RECEIVED").length).toBe(1);
            expect(third.treasury.ledger.balance("cash.operating")).toBe(u("0.01"));
            expect(third.sales.length).toBe(1);
        } finally {
            await scratch.drop();
        }
    });

    it("keeps the owner's changed terms, and does not reset them to the code's", async () => {
        const scratch = await scratchSchema();
        try {
            const first = await boot(scratch);
            const res = await request(first.app)
                .post("/mandate")
                .set("Authorization", "Bearer owner-token-for-tests-only")
                .send({ maxSlippageBps: 42 });
            expect(res.status).toBe(200);
            expect(res.body.version).toBe(2);

            const second = await boot(scratch);
            expect(second.mandates.current().version).toBe(2);
            expect(second.mandates.current().terms.maxSlippageBps).toBe(42);
            expect(second.mandates.verifyChain()).toBe(true);
        } finally {
            await scratch.drop();
        }
    });

    it("signs the owner in on one instance and recognises them on the next", async () => {
        const scratch = await scratchSchema();
        try {
            const first = await boot(scratch);
            const { token } = await first.backends.sessions.open(config.ownerAddress);

            const second = await boot(scratch);
            const me = await request(second.app).get("/auth/me").set("Cookie", `surplus_session=${token}`);
            expect(me.body).toEqual({ signedIn: true, address: config.ownerAddress });

            // and an owner route lets that cookie through without the token
            const mandate = await request(second.app).get("/mandate").set("Cookie", `surplus_session=${token}`);
            expect(mandate.status).toBe(200);
        } finally {
            await scratch.drop();
        }
    });
});
