import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
    BASE_REGISTRY, MandateStore, parseUsdc as u,
    type MandateTerms, type SavedBrief, type Brief,
} from "@surplus/core";
import { buildServer, BRIEF_ROUTE } from "../src/server";
import { loadConfig } from "../src/config";
import { JsonlReceiptStore, newReceiptId, parseReceiptLine } from "../src/receipts";

const dirs: string[] = [];
function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), "surplus-receipts-"));
    dirs.push(d);
    return d;
}
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TX = "0x" + "ab".repeat(32);

const receipt = (over: Partial<Parameters<JsonlReceiptStore["issue"]>[0]> = {}) => ({
    id: newReceiptId(),
    briefId: "brief-test",
    source: "catalogue" as const,
    transaction: TX,
    amountUsdcMinor: "10000",
    at: "2026-11-21T00:00:00.000Z",
    ...over,
});

describe("the receipt store", () => {
    it("round-trips a receipt through disk", async () => {
        const path = join(freshDir(), "nested", "receipts.jsonl");
        const store = new JsonlReceiptStore(path);
        const r = receipt();
        await store.issue(r);

        const reopened = new JsonlReceiptStore(path);
        expect(await reopened.find(r.id)).toEqual(r);
        expect(await reopened.count()).toBe(1);
    });

    it("issues one receipt per settlement, however often it is replayed", async () => {
        const path = join(freshDir(), "receipts.jsonl");
        const store = new JsonlReceiptStore(path);
        const r = receipt();
        await store.issue(r);
        await store.issue(r);
        expect(await store.count()).toBe(1);
        expect(readFileSync(path, "utf8").trimEnd().split("\n").length).toBe(1);
    });

    it("finds the receipt a settlement produced", async () => {
        const store = new JsonlReceiptStore(join(freshDir(), "receipts.jsonl"));
        const r = receipt();
        await store.issue(r);
        expect((await store.forTransaction(TX.toUpperCase()))?.id).toBe(r.id);
        expect(await store.forTransaction("0x" + "cd".repeat(32))).toBe(null);
    });

    it("mints ids that are long and url safe", () => {
        const ids = new Set(Array.from({ length: 200 }, () => newReceiptId()));
        expect(ids.size).toBe(200);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    });

    it("refuses a malformed stored line rather than guessing", () => {
        expect(() => parseReceiptLine("{not json", "f")).toThrow();
        expect(() => parseReceiptLine(JSON.stringify({ id: "x" }), "f")).toThrow(/briefId is missing/);
    });
});

const PAY_TO = "0x" + "a".repeat(40);
const config = loadConfig({
    X402_PAY_TO: PAY_TO,
    OWNER_TOKEN: "owner-token-for-tests-only",
    OWNER_ADDRESS: "0x" + "9".repeat(40),
} as NodeJS.ProcessEnv);

const terms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [{ id: "ai-compute", targetBps: 10000 }],
    maxCompanyBps: 4000, investShareBps: 5000,
    maxTradeUsdc: u("1.00"), minTradeUsdc: u("0.05"), reserveTargetUsdc: u("2.00"),
    maxSlippageBps: 100, driftToleranceBps: 100, approvalExpirySeconds: 600,
};
const mandateFor = () => { const m = new MandateStore(); m.create(terms); return m; };

const brief: Brief = {
    id: "brief-test", createdAt: "2026-11-21T00:00:00.000Z",
    sources: [], themes: [], disclaimer: "d",
};
const saved: SavedBrief = { file: "b.json", provider: "p", model: "m", brief, costUsdcMinor: 1n, costUsd: 0.01 };

describe("the receipt route", () => {
    const build = () => {
        const receipts = new JsonlReceiptStore(join(freshDir(), "receipts.jsonl"));
        const built = buildServer({
            config,
            mandates: mandateFor(),
            readBrief: () => saved,
            findBrief: (id) => (id === saved.brief.id ? saved : null),
            receipts,
        });
        return { ...built, receipts };
    };

    it("does not let a settlement transaction be used as the key", async () => {
        // The mistake this guards: settlements are public on Base, so keying receipts on the transaction
        // would let anyone watching the seller's address read briefs they never bought.
        const { app, receipts } = build();
        await receipts.issue(receipt());
        const res = await request(app).get(`/receipt/${TX}`);
        expect(res.status).toBe(404);
    });

    it("serves the brief to whoever holds the receipt link", async () => {
        const { app, receipts } = build();
        const r = receipt();
        await receipts.issue(r);
        const res = await request(app).get(`/receipt/${r.id}`);
        expect(res.status).toBe(200);
        expect(res.body.brief.id).toBe("brief-test");
        expect(res.body.receipt.transaction).toBe(TX);
    });

    it("answers the same way for an unknown id and a malformed one, so it cannot be probed", async () => {
        const { app } = build();
        const unknown = await request(app).get(`/receipt/${newReceiptId()}`);
        const malformed = await request(app).get("/receipt/!!");
        expect(unknown.status).toBe(404);
        expect(malformed.status).toBe(404);
        expect(unknown.body).toEqual(malformed.body);
    });

    it("says so when the brief behind a valid receipt is gone", async () => {
        const { app, receipts } = build();
        await receipts.issue(receipt({ briefId: "brief-that-was-deleted" }));
        const r = (await receipts.find((await receipts.forTransaction(TX))!.id))!;
        const res = await request(app).get(`/receipt/${r.id}`);
        expect(res.status).toBe(410);
        expect(res.body.receipt.transaction).toBe(TX);
    });

    it("is absent when the server was built without a receipt store", async () => {
        const { app } = buildServer({ config, mandates: mandateFor(), readBrief: () => saved });
        expect((await request(app).get(`/receipt/${newReceiptId()}`)).status).toBe(404);
    });

    it("hands a receipt link back only on a paid response", async () => {
        const { app } = build();
        const unpaid = await request(app).get(BRIEF_ROUTE);
        expect(unpaid.status).toBe(402);
        expect(JSON.stringify(unpaid.body)).not.toContain("receipt");
    });
});

describe("the public catalogue", () => {
    it("shows what is sold and at what price, without giving the claims away", async () => {
        const receipts = new JsonlReceiptStore(join(freshDir(), "receipts.jsonl"));
        const { app } = buildServer({ config, mandates: mandateFor(), readBrief: () => saved, receipts });
        const res = await request(app).get("/catalogue");
        expect(res.status).toBe(200);
        expect(res.body.briefPriceUsd).toBe("$0.01");
        expect(res.body.researchPriceUsd).toBe("$2.00");
        expect(res.body.latest.id).toBe("brief-test");
        // the teaser must never carry a claim or a quote
        expect(JSON.stringify(res.body)).not.toContain("quotes");
        expect(JSON.stringify(res.body)).not.toContain("claims");
    });
});
