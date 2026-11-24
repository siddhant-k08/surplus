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
import { RECOVERY_TYPES } from "../src/recovery";
import { privateKeyToAccount } from "viem/accounts";

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
        // a line written before the network existed parses, and gains no network from anywhere
        const older = parseReceiptLine(JSON.stringify({
            id: "a".repeat(12), briefId: "b", source: "catalogue",
            transaction: TX, amountUsdcMinor: "10000", at: new Date().toISOString(),
        }), "f");
        expect(older.network).toBeUndefined();
        const newer = parseReceiptLine(JSON.stringify({ ...older, network: "eip155:8453" }), "f");
        expect(newer.network).toBe("eip155:8453");
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

    it("reports the network a new receipt settled on", async () => {
        const { app, receipts } = build();
        const r = { ...receipt(), network: "eip155:84532" };
        await receipts.issue(r);
        const res = await request(app).get(`/receipt/${r.id}`);
        expect(res.status).toBe(200);
        expect(res.body.receipt.network).toBe("eip155:84532");
    });

    it("leaves the network null on a receipt written before it was stored", async () => {
        // The old rows are real and must stay readable. Filling this in from the running config would
        // point a buyer's transaction at whichever chain this server happens to be on today, which is
        // not evidence of where their sale settled.
        const { app, receipts } = build();
        const old = receipt();
        expect("network" in old).toBe(false);
        await receipts.issue(old);
        const res = await request(app).get(`/receipt/${old.id}`);
        expect(res.status).toBe(200);
        expect(res.body.receipt.network).toBeNull();
        expect(res.body.brief.id).toBe("brief-test");
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
        expect(res.body.briefPriceUsd).toBe("$0.25");
        expect(res.body.researchPriceUsd).toBe("$2.00");
        expect(res.body.latest.id).toBe("brief-test");
        // the teaser must never carry a claim or a quote
        expect(JSON.stringify(res.body)).not.toContain("quotes");
        expect(JSON.stringify(res.body)).not.toContain("claims");
    });
});


describe("getting a lost receipt link back", () => {
    const BUYER = privateKeyToAccount(("0x" + "55".repeat(32)) as `0x${string}`);
    const STRANGER = privateKeyToAccount(("0x" + "66".repeat(32)) as `0x${string}`);

    /** A server with two buyers' purchases already recorded. */
    const build = async () => {
        const receipts = new JsonlReceiptStore(join(freshDir(), "receipts.jsonl"));
        const mine = receipt({ payer: BUYER.address, briefId: "brief-mine", at: "2026-11-21T00:00:00.000Z" });
        const older = receipt({
            payer: BUYER.address.toLowerCase(), briefId: "brief-older",
            transaction: "0x" + "11".repeat(32), at: "2026-11-20T00:00:00.000Z",
        });
        const theirs = receipt({
            payer: STRANGER.address, briefId: "brief-theirs", transaction: "0x" + "22".repeat(32),
        });
        for (const r of [mine, older, theirs]) await receipts.issue(r);
        const built = buildServer({ config, mandates: mandateFor(), readBrief: () => saved, receipts });
        return { ...built, receipts, mine, older, theirs };
    };

    /** The handshake a wallet performs: ask for a nonce, sign exactly what was offered. */
    const prove = async (app: Parameters<typeof request>[0], account: typeof BUYER, claimed = account.address) => {
        const offer = await request(app).post("/receipt/nonce").send({ address: claimed });
        const signature = await account.signTypedData({
            domain: offer.body.domain,
            types: RECOVERY_TYPES,
            primaryType: "Recover",
            message: {
                statement: offer.body.message.statement,
                address: offer.body.message.address,
                nonce: offer.body.message.nonce,
                issuedAt: BigInt(offer.body.message.issuedAt),
            },
        });
        return { nonce: offer.body.message.nonce as string, signature, offer };
    };

    it("gives a buyer back every link they paid for, and nobody else's", async () => {
        const { app, mine, older } = await build();
        const { nonce, signature } = await prove(app, BUYER);

        const res = await request(app).post("/receipt/recover").send({ address: BUYER.address, nonce, signature });
        expect(res.status).toBe(200);
        expect(res.body.address).toBe(BUYER.address);
        // newest first, and matched whatever case the payer was recorded in
        expect(res.body.receipts.map((r: { id: string }) => r.id)).toEqual([mine.id, older.id]);
        expect(res.body.receipts.map((r: { briefId: string }) => r.briefId)).not.toContain("brief-theirs");
        expect(res.body.receipts[0].url).toBe(`/r/${mine.id}`);
    });

    it("refuses a signature from a different wallet than the address claimed", async () => {
        // the attack this stops: payers are public on Base, so an address alone must prove nothing
        const { app } = await build();
        const offer = await request(app).post("/receipt/nonce").send({ address: BUYER.address });
        const signature = await STRANGER.signTypedData({
            domain: offer.body.domain,
            types: RECOVERY_TYPES,
            primaryType: "Recover",
            message: {
                statement: offer.body.message.statement,
                address: offer.body.message.address,
                nonce: offer.body.message.nonce,
                issuedAt: BigInt(offer.body.message.issuedAt),
            },
        });
        const res = await request(app)
            .post("/receipt/recover")
            .send({ address: BUYER.address, nonce: offer.body.message.nonce, signature });
        expect(res.status).toBe(401);
        expect(res.body.receipts).toBeUndefined();
    });

    it("spends the nonce, so a captured signature cannot be replayed", async () => {
        const { app } = await build();
        const { nonce, signature } = await prove(app, BUYER);
        const first = await request(app).post("/receipt/recover").send({ address: BUYER.address, nonce, signature });
        expect(first.status).toBe(200);

        const replay = await request(app).post("/receipt/recover").send({ address: BUYER.address, nonce, signature });
        expect(replay.status).toBe(400);
        expect(replay.body.receipts).toBeUndefined();
    });

    it("refuses a nonce this server never issued", async () => {
        const { app } = await build();
        const { signature } = await prove(app, BUYER);
        const res = await request(app)
            .post("/receipt/recover")
            .send({ address: BUYER.address, nonce: "a".repeat(32), signature });
        expect(res.status).toBe(400);
    });

    it("answers an address with no purchases with an empty list, not an error", async () => {
        const { app } = await build();
        const nobody = privateKeyToAccount(("0x" + "77".repeat(32)) as `0x${string}`);
        const { nonce, signature } = await prove(app, nobody);
        const res = await request(app).post("/receipt/recover").send({ address: nobody.address, nonce, signature });
        expect(res.status).toBe(200);
        expect(res.body.receipts).toEqual([]);
    });

    it("records the payer when a settlement reports one", async () => {
        const store = new JsonlReceiptStore(join(freshDir(), "receipts.jsonl"));
        const r = receipt({ payer: BUYER.address });
        await store.issue(r);
        const back = await store.find(r.id);
        expect(back?.payer).toBe(BUYER.address);
        expect((await store.forPayer(BUYER.address)).length).toBe(1);

        // a receipt written before the payer was recorded is simply not recoverable, never a crash
        const legacy = receipt({ transaction: "0x" + "33".repeat(32) });
        delete (legacy as { payer?: string }).payer;
        await store.issue(legacy);
        expect((await store.forPayer(BUYER.address)).length).toBe(1);
    });
});

describe("the public themes and filings pages", () => {
    // its own fixture: the shared one is deliberately empty, and these routes are about content
    const withContent: SavedBrief = {
        ...saved,
        brief: {
            ...brief,
            sources: [
                {
                    id: "TSLA-10K", tier: 1, title: "Tesla 10-K", publisher: "SEC EDGAR",
                    url: "https://sec.gov/tsla", publishedAt: "2026-01-29",
                    retrievedAt: "2026-11-20T00:00:00.000Z", excerpt: "an excerpt",
                },
                {
                    id: "GOOGL-10K", tier: 1, title: "Alphabet 10-K", publisher: "SEC EDGAR",
                    url: "https://sec.gov/googl", publishedAt: "2026-02-05",
                    retrievedAt: "2026-11-20T00:00:00.000Z", excerpt: "an excerpt",
                },
            ],
            themes: [
                {
                    themeId: "ai-compute",
                    gap: false,
                    claims: [{ id: "c1", type: "fact", text: "a claim", sourceIds: ["TSLA-10K"], quotes: [{ sourceId: "TSLA-10K", text: "a quote" }] }],
                    fits: [
                        { asset: "0x1", symbol: "TSLAc", fit: 3, evidence: 2, claimIds: ["c1"] },
                        { asset: "0x2", symbol: "GOOGLc", fit: 5, evidence: 2, claimIds: ["c1"] },
                    ],
                },
                { themeId: "longevity-biotech", gap: true, gapReason: "nothing cleared the bar", claims: [], fits: [] },
            ],
        },
    };

    const build = () =>
        buildServer({
            config,
            mandates: mandateFor(),
            readBrief: () => withContent,
            catalogueBriefs: async () => [withContent, withContent],
        }).app;

    it("lists themes with how often each was researched", async () => {
        const res = await request(build()).get("/catalogue/themes");
        expect(res.status).toBe(200);
        expect(res.body.briefs).toBe(2);
        const ai = res.body.themes.find((t: { id: string }) => t.id === "ai-compute");
        expect(ai.briefs).toBe(2);
        expect(res.body.themes.find((t: { id: string }) => t.id === "longevity-biotech").gaps).toBe(2);
    });

    it("counts a company once however many briefs it appears in", async () => {
        // the same brief twice must not double the companies, or the page overstates the work
        const res = await request(build()).get("/catalogue/themes");
        const ai = res.body.themes.find((t: { id: string }) => t.id === "ai-compute");
        expect(ai.companies).toBe(2);
        expect(new Set(ai.symbols).size).toBe(2);
    });

    it("lists each filing once, newest first, with the url the API already had", async () => {
        const res = await request(build()).get("/catalogue/filings");
        expect(res.status).toBe(200);
        expect(res.body.filings.map((f: { id: string }) => f.id)).toEqual(["GOOGL-10K", "TSLA-10K"]);
        expect(res.body.filings[0].url).toBe("https://sec.gov/googl");
        expect(res.body.filings[0].citedBy).toBe(2);
    });

    it("never carries a claim or a quote, because those are what a buyer paid for", async () => {
        const body = JSON.stringify((await request(build()).get("/catalogue/filings")).body)
            + JSON.stringify((await request(build()).get("/catalogue/themes")).body);
        expect(body).not.toContain("a quote");
        expect(body).not.toContain("a claim");
        // the stored excerpt is filing text the agent pulled for the brief, so it is not free either
        expect(body).not.toContain("an excerpt");
    });

    it("is absent when the server was built without a catalogue, rather than answering empty", async () => {
        const bare = buildServer({ config, mandates: mandateFor(), readBrief: () => saved });
        expect((await request(bare.app).get("/catalogue/themes")).status).toBe(404);
        expect((await request(bare.app).get("/catalogue/filings")).status).toBe(404);
    });
});
