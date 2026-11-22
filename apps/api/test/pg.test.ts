import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
    Ledger,
    MandateStore,
    openLedger,
    openMandateFrom,
    flushNewEntries,
    parseUsdc as u,
    type LedgerTx,
    type MandateTerms,
    type SavedBrief,
} from "@surplus/core";
import {
    PgLedgerStore, PgMandateBackend, PgReceiptStore, PgBriefBackend, PgSessionStore,
} from "../src/pg";
import { PgThrottle } from "../src/throttle";
import { PgReservations } from "../src/reservations";
import { PgJournal } from "../src/journal";
import { newReceiptId, type Receipt } from "../src/receipts";
import type { BriefDocument } from "../src/briefs";
import { scratchSchema, hasDatabase, type Scratch } from "./pghelp";

/**
 * The Postgres backends against a real Postgres.
 *
 * Skipped when DATABASE_URL is unset, because a fake would prove nothing: what is being tested here is
 * that the database keeps the same promises the files do, and only a real server can refuse a second
 * write or answer a race the way the real one will.
 */
const describeDb = hasDatabase ? describe : describe.skip;

// Every assertion here is a round trip to a hosted database, so the default five seconds is a latency
// measurement rather than a test result.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let scratch: Scratch;
beforeAll(async () => {
    if (hasDatabase) scratch = await scratchSchema();
}, 60_000);
afterAll(async () => {
    if (hasDatabase && scratch !== undefined) await scratch.drop();
}, 60_000);

const sale = (id: number, tx: string): Omit<LedgerTx, "id"> & { id?: number } => ({
    type: "PAYMENT_RECEIVED",
    mode: "testnet",
    at: new Date(`2026-11-21T00:00:0${id}Z`).toISOString(),
    idempotencyKey: `x402:${tx}`,
    txHash: tx,
    briefId: "brief-1",
    memo: "x402 sale",
    lines: [
        { account: "cash.operating", amount: u("0.01") },
        { account: "revenue.research", amount: u("-0.01") },
    ],
});

const post = (l: Ledger, id: number, tx: string): void => {
    const { id: _ignored, at, ...rest } = sale(id, tx);
    l.post({ ...rest, at: new Date(at) });
};

const baseTerms = (over: Partial<MandateTerms> = {}): MandateTerms => ({
    eligible: ["0x1111111111111111111111111111111111111111"],
    themes: [{ id: "ai-compute", targetBps: 10_000 }],
    maxCompanyBps: 4000,
    investShareBps: 5000,
    maxTradeUsdc: u("1.00"),
    minTradeUsdc: u("0.05"),
    reserveTargetUsdc: u("2.00"),
    maxSlippageBps: 100,
    driftToleranceBps: 100,
    approvalExpirySeconds: 600,
    ...over,
});

describeDb("the configured database", () => {
    it("is reachable, so a connection failure is a failed test and not a skipped one", async () => {
        const [row] = await scratch.sql<{ ok: number }[]>`select 1 as ok`;
        expect(row?.ok).toBe(1);
    }, 60_000);
});

describeDb("the ledger in Postgres", () => {
    it("round-trips every field, and the restored ledger refuses a replayed settlement", async () => {
        const store = new PgLedgerStore(scratch.sql, "sales-roundtrip");
        const live = new Ledger();
        post(live, 1, "0xaaa");
        live.post({
            type: "COST_ACCRUED", mode: "testnet", at: new Date("2026-11-21T00:00:05Z"),
            briefId: "brief-1", memo: "metered",
            lines: [
                { account: "expense.llm", amount: u("0.021188") },
                { account: "cash.operating", amount: u("-0.021188") },
            ],
        });
        await store.append(live.all());

        const back = await openLedger(store);
        expect(back.all()).toEqual(live.all());
        expect([...back.balances()]).toEqual([...live.balances()]);
        expect(back.all()[0]!.txHash).toBe("0xaaa");
        expect(back.all()[0]!.idempotencyKey).toBe("x402:0xaaa");
        expect(back.balance("cash.operating")).toBe(u("0.01") - u("0.021188"));

        // the facilitator replays a settlement after a restart; the restored dedup index must refuse it
        post(back, 1, "0xaaa");
        expect(back.all().length).toBe(2);
        expect(back.balance("cash.operating")).toBe(u("0.01") - u("0.021188"));
    });

    it("stores money as decimal strings of minor units, never a number", async () => {
        const store = new PgLedgerStore(scratch.sql, "sales-strings");
        const live = new Ledger();
        post(live, 1, "0xbbb");
        await store.append(live.all());

        const [row] = await scratch.sql<{ line: string }[]>`
            select line from ledger_entries where book = 'sales-strings' and id = 1
        `;
        expect(row!.line).toContain('"amount":"10000"');
        expect(JSON.parse(row!.line).lines[0].amount).toBe("10000");
    });

    it("appends only what is new, however often the same flush is retried", async () => {
        const store = new PgLedgerStore(scratch.sql, "sales-retry");
        const live = new Ledger();
        post(live, 1, "0xccc");

        let mark = await flushNewEntries(live, store, 0);
        expect(mark).toBe(1);
        await store.append(live.all()); // the write is retried after a failure that had in fact landed
        mark = await flushNewEntries(live, store, mark);
        expect(mark).toBe(1);
        expect((await store.load()).length).toBe(1);

        post(live, 2, "0xddd");
        mark = await flushNewEntries(live, store, mark);
        expect(mark).toBe(2);
        expect((await store.load()).length).toBe(2);
    });

    it("keeps the sales book and the investing book apart", async () => {
        const sales = new PgLedgerStore(scratch.sql, "two-sales");
        const invest = new PgLedgerStore(scratch.sql, "two-invest");
        const real = new Ledger();
        post(real, 1, "0xeee");
        await sales.append(real.all());

        const sim = new Ledger();
        sim.post({
            type: "OPENING_BALANCE", mode: "sim", at: new Date("2026-11-21T00:00:00Z"),
            memo: "opening reserve (simulated)",
            lines: [
                { account: "reserve", amount: u("1.50") },
                { account: "equity.opening", amount: u("-1.50") },
            ],
        });
        await invest.append(sim.all());

        expect((await sales.load()).map((t) => t.mode)).toEqual(["testnet"]);
        expect((await invest.load()).map((t) => t.mode)).toEqual(["sim"]);
    });

    it("notices a gap in the entry ids rather than loading a book that is not intact", async () => {
        const store = new PgLedgerStore(scratch.sql, "gap");
        const live = new Ledger();
        post(live, 1, "0xf11");
        post(live, 2, "0xf22");
        await store.append(live.all());
        await scratch.sql`delete from ledger_entries where book = 'gap' and id = 1`;
        await expect(store.load()).rejects.toThrow(/missing its beginning/);

        // and a hole in the middle, which is the case a single missing id check would let through
        const middle = new PgLedgerStore(scratch.sql, "gap-middle");
        const three = new Ledger();
        post(three, 1, "0xf41");
        post(three, 2, "0xf42");
        post(three, 3, "0xf43");
        await middle.append(three.all());
        await scratch.sql`delete from ledger_entries where book = 'gap-middle' and id = 2`;
        await expect(middle.load()).rejects.toThrow(/jump from 1 to 3/);
    });

    it("refuses a row whose money was edited in the database", async () => {
        const store = new PgLedgerStore(scratch.sql, "edited");
        const live = new Ledger();
        post(live, 1, "0xf33");
        await store.append(live.all());
        await scratch.sql`
            update ledger_entries set line = ${'{"id":1,"at":"2026-11-21T00:00:01.000Z","type":"PAYMENT_RECEIVED","mode":"testnet","lines":[{"account":"cash.operating","amount":0.01}]}'}
            where book = 'edited' and id = 1
        `;
        await expect(store.load()).rejects.toThrow(/decimal string of minor units/);
    });
});

describeDb("the mandate in Postgres", () => {
    it("round-trips a version with its hash chain verified", async () => {
        const backend = new PgMandateBackend(scratch.sql);
        const live = new MandateStore();
        await backend.append(live.create(baseTerms()));
        await backend.append(live.create(baseTerms({ maxSlippageBps: 50 })));

        const { mandates, created } = await openMandateFrom(backend, baseTerms({ maxSlippageBps: 999 }));
        expect(created).toBe(false);
        expect(mandates.history().length).toBe(2);
        expect(mandates.current().version).toBe(2);
        expect(mandates.current().prevHash).toBe(mandates.get(1)!.hash);
        expect(mandates.current().terms.maxSlippageBps).toBe(50);
        expect(mandates.current().terms.maxTradeUsdc).toBe(u("1.00"));
        expect(mandates.verifyChain()).toBe(true);
    });

    it("stores limits as strings so a constraint never passes through a float", async () => {
        const [row] = await scratch.sql<{ line: string }[]>`
            select line from mandate_versions where version = 1
        `;
        expect(JSON.parse(row!.line).terms.maxTradeUsdc).toBe("1000000");
        expect(row!.line).not.toContain("1e+");
    });

    it("accepts the same version twice, and refuses a different one at the same number", async () => {
        const backend = new PgMandateBackend(scratch.sql);
        const stored = (await backend.load())[0]!;
        await backend.append(stored); // a retry after a write that had in fact landed
        expect((await backend.load()).length).toBe(2);

        const rival = new MandateStore();
        const forged = rival.create(baseTerms({ investShareBps: 9999 }));
        await expect(backend.append(forged)).rejects.toThrow(/already stored with a different hash/);
    });

    it("creates version 1 from the code's terms only when nothing is stored", async () => {
        // its own schema, because this is about a database that holds no mandate at all
        const empty = await scratchSchema();
        try {
            const backend = new PgMandateBackend(empty.sql);
            const { mandates, created } = await openMandateFrom(backend, baseTerms({ maxSlippageBps: 77 }));
            expect(created).toBe(true);
            expect(mandates.current().version).toBe(1);
            expect(mandates.current().terms.maxSlippageBps).toBe(77);
            expect((await backend.load()).length).toBe(1);

            // a later deployment ships different defaults; the owner's stored terms must win
            const again = await openMandateFrom(backend, baseTerms({ maxSlippageBps: 999 }));
            expect(again.created).toBe(false);
            expect(again.mandates.current().terms.maxSlippageBps).toBe(77);
            expect((await backend.load()).length).toBe(1);
        } finally {
            await empty.drop();
        }
    }, 60_000);
});

describeDb("receipts in Postgres", () => {
    const receipt = (over: Partial<Receipt> = {}): Receipt => ({
        id: newReceiptId(),
        briefId: "brief-1",
        source: "catalogue",
        transaction: "0x" + "ab".repeat(32),
        amountUsdcMinor: "10000",
        at: "2026-11-21T00:00:00.000Z",
        ...over,
    });

    it("finds a receipt only by its secret, and counts what it issued", async () => {
        const store = new PgReceiptStore(scratch.sql);
        const r = receipt();
        await store.issue(r);
        expect(await store.find(r.id)).toEqual(r);
        expect(await store.find(newReceiptId())).toBe(null);
        expect(await store.count()).toBe(1);
    });

    it("stores the settlement network, and leaves it undefined on a row without one", async () => {
        // the column was added after receipts already existed, so it is nullable and old rows stay null
        // its own schema: tests after this one assert absolute counts in the shared one
        const only = await scratchSchema();
        try {
            const store = new PgReceiptStore(only.sql);
            const withNetwork = receipt({ transaction: "0x" + "b1".repeat(32), network: "eip155:84532" });
            const without = receipt({ transaction: "0x" + "b2".repeat(32) });
            await store.issue(withNetwork);
            await store.issue(without);
            expect((await store.find(withNetwork.id))?.network).toBe("eip155:84532");
            expect((await store.find(without.id))?.network).toBeUndefined();
        } finally {
            await only.drop();
        }
    }, 60_000);

    it("issues one receipt per settlement, however often it is replayed", async () => {
        const store = new PgReceiptStore(scratch.sql);
        const r = receipt({ transaction: "0x" + "cd".repeat(32) });
        await store.issue(r);
        await store.issue(r);
        expect(await store.count()).toBe(2); // the one above plus this one, not three
    });

    it("finds a payer's own receipts, whatever case the address was recorded in", async () => {
        // the durability story: the receipt id travels once, in the paid response, so a buyer whose
        // response was lost gets back in by proving the wallet that paid
        const only = await scratchSchema();
        try {
            const store = new PgReceiptStore(only.sql);
            const payer = "0x" + "AB".repeat(20);
            const mine = receipt({ payer, transaction: "0x" + "a1".repeat(32), at: "2026-11-21T00:00:00.000Z" });
            const older = receipt({ payer: payer.toLowerCase(), transaction: "0x" + "a2".repeat(32), at: "2026-11-20T00:00:00.000Z" });
            const theirs = receipt({ payer: "0x" + "cd".repeat(20), transaction: "0x" + "a3".repeat(32) });
            const anonymous = receipt({ transaction: "0x" + "a4".repeat(32) });
            delete (anonymous as { payer?: string }).payer;
            for (const r of [mine, older, theirs, anonymous]) await store.issue(r);

            const found = await store.forPayer(payer);
            expect(found.map((r) => r.id)).toEqual([mine.id, older.id]); // newest first
            expect(found[0]!.payer?.toLowerCase()).toBe(payer.toLowerCase());
            expect(await store.forPayer("0x" + "ff".repeat(20))).toEqual([]);
        } finally {
            await only.drop();
        }
    }, 60_000);

    it("matches a settlement transaction whatever its case", async () => {
        const store = new PgReceiptStore(scratch.sql);
        const tx = "0x" + "ef".repeat(32);
        const r = receipt({ transaction: tx });
        await store.issue(r);
        expect((await store.forTransaction(tx.toUpperCase()))?.id).toBe(r.id);
        expect(await store.forTransaction("0x" + "99".repeat(32))).toBe(null);
    });
});

describeDb("briefs in Postgres", () => {
    const savedBrief = (id: string, createdAt: string): { saved: SavedBrief; doc: BriefDocument } => {
        const brief = {
            id,
            createdAt,
            disclaimer: "Informational only, not investment advice.",
            themes: [],
        };
        const doc: BriefDocument = {
            provider: "gemini",
            model: "gemini-2.5-flash",
            themesKey: "abc123",
            brief,
            costUsd: 0.0212,
            costUsdcMinor: "21200",
        };
        return {
            saved: {
                file: `${id}.json`,
                provider: "gemini",
                model: "gemini-2.5-flash",
                brief: brief as unknown as SavedBrief["brief"],
                costUsdcMinor: 21_200n,
                costUsd: 0.0212,
                themesKey: "abc123",
            },
            doc,
        };
    };

    it("stores a commissioned brief and reads it back newest first", async () => {
        const custom = new PgBriefBackend(scratch.sql, "custom");
        const older = savedBrief("brief-older", "2026-11-20T00:00:00.000Z");
        const newer = savedBrief("brief-newer", "2026-11-21T00:00:00.000Z");
        await custom.save(older.saved, older.doc);
        await custom.save(newer.saved, newer.doc);

        const back = await custom.list();
        expect(back.map((b) => b.brief.id)).toEqual(["brief-newer", "brief-older"]);
        expect(back[0]!.costUsdcMinor).toBe(21_200n);
        expect(back[0]!.themesKey).toBe("abc123");
        expect(await custom.problems()).toEqual([]);
    });

    it("keeps the owner's catalogue and buyer-commissioned work apart", async () => {
        const catalogue = new PgBriefBackend(scratch.sql, "catalogue");
        const owned = savedBrief("brief-catalogue", "2026-11-21T00:00:00.000Z");
        await catalogue.save(owned.saved, owned.doc);

        expect((await catalogue.list()).map((b) => b.brief.id)).toEqual(["brief-catalogue"]);
        const custom = new PgBriefBackend(scratch.sql, "custom");
        expect((await custom.list()).map((b) => b.brief.id)).not.toContain("brief-catalogue");
    });

    it("stores a brief once, so a replayed save cannot overwrite a buyer's brief", async () => {
        const custom = new PgBriefBackend(scratch.sql, "custom");
        const first = savedBrief("brief-same-id", "2026-11-21T00:00:00.000Z");
        await custom.save(first.saved, first.doc);
        const second = savedBrief("brief-same-id", "2026-11-21T00:00:00.000Z");
        second.doc.costUsdcMinor = "999999";
        await custom.save(second.saved, second.doc);

        const found = (await custom.list()).filter((b) => b.brief.id === "brief-same-id");
        expect(found.length).toBe(1);
        expect(found[0]!.costUsdcMinor).toBe(21_200n);
    });

    it("sums what a collection cost, which is how the spend cap survives a cold start", async () => {
        // The research budget is counted from the stored briefs rather than from a field on the running
        // process, so every instance sees the same total. Summed in the database because it is read on
        // the path of every paid request.
        // its own schema: this asserts an absolute total, which anything else writing briefs would move
        const only = await scratchSchema();
        try {
            const custom = new PgBriefBackend(only.sql, "custom");
            const catalogue = new PgBriefBackend(only.sql, "catalogue");
            expect(await custom.totalCostUsdcMinor()).toBe(0n);

            const a = savedBrief("brief-cost-a", "2026-11-21T00:00:00.000Z");
            const b = savedBrief("brief-cost-b", "2026-11-21T00:00:01.000Z");
            await custom.save(a.saved, a.doc);
            await custom.save(b.saved, b.doc);
            expect(await custom.totalCostUsdcMinor()).toBe(21_200n * 2n);

            // the owner's catalogue was not generated out of this budget and must not count against it
            const owned = savedBrief("brief-cost-catalogue", "2026-11-21T00:00:02.000Z");
            await catalogue.save(owned.saved, owned.doc);
            expect(await custom.totalCostUsdcMinor()).toBe(21_200n * 2n);
            expect(await catalogue.totalCostUsdcMinor()).toBe(21_200n);
        } finally {
            await only.drop();
        }
    }, 60_000);

    it("reports a brief it cannot read instead of throwing, because that is a missing model cost", async () => {
        const custom = new PgBriefBackend(scratch.sql, "custom");
        await scratch.sql`
            insert into briefs ${scratch.sql([{
                id: "brief-broken",
                collection: "custom",
                file: "brief-broken.json",
                created_at: new Date("2026-11-21T00:00:00.000Z"),
                document: scratch.sql.json({ provider: "gemini", brief: { id: "brief-broken" } }),
            }])}
        `;
        const problems = await custom.problems();
        expect(problems.map((p) => p.file)).toContain("brief-broken.json");
        expect((await custom.list()).map((b) => b.brief.id)).not.toContain("brief-broken");
    });
});

describeDb("the rate limit in Postgres", () => {
    it("is one allowance across every instance, not one each", async () => {
        // the point of putting it in the database: a per-process limiter on a host that runs many
        // instances is the limit multiplied by however many happen to be running
        const only = await scratchSchema();
        try {
            let now = Date.parse("2026-11-22T00:00:00Z");
            const a = new PgThrottle(only.sql, () => now);
            const b = new PgThrottle(only.sql, () => now);

            expect(await a.allow("k", 3, 60_000)).toBe(true);
            expect(await b.allow("k", 3, 60_000)).toBe(true);
            expect(await a.allow("k", 3, 60_000)).toBe(true);
            expect(await b.allow("k", 3, 60_000)).toBe(false); // the fourth, wherever it came from

            expect(await a.allow("someone-else", 3, 60_000)).toBe(true);

            now += 60_001;
            expect(await b.allow("k", 3, 60_000)).toBe(true); // a fresh window
        } finally {
            await only.drop();
        }
    }, 60_000);
});

describeDb("research reservations in Postgres", () => {
    it("lets the first instance through and makes the second stand down", async () => {
        // the residual race the in-process reservation could not close: two instances starting a
        // generation in the same instant, each blind to the other's commitment
        const only = await scratchSchema();
        try {
            let now = Date.parse("2026-11-22T00:00:00Z");
            const a = new PgReservations(only.sql, () => now);
            const b = new PgReservations(only.sql, () => now);

            const first = await a.open(1_000_000n);
            now += 1; // b reserves a moment later
            const second = await b.open(1_000_000n);

            // each asks what was committed ahead of it, and they agree on the order
            expect(await a.outstandingBefore(first)).toBe(0n);
            expect(await b.outstandingBefore(second)).toBe(1_000_000n);
            expect(await a.outstanding()).toBe(2_000_000n);

            await b.close(second);
            expect(await a.outstanding()).toBe(1_000_000n);
        } finally {
            await only.drop();
        }
    }, 60_000);

    it("forgets a reservation an instance died holding", async () => {
        // a budget permanently consumed by a crash would be a worse failure than the overspend this
        // guards against
        const only = await scratchSchema();
        try {
            let now = Date.parse("2026-11-22T00:00:00Z");
            const r = new PgReservations(only.sql, () => now);
            await r.open(1_000_000n);
            expect(await r.outstanding()).toBe(1_000_000n);

            now += 10 * 60_000 + 1;
            expect(await r.outstanding()).toBe(0n);
            const [row] = await only.sql<{ n: string }[]>`select count(*)::text as n from research_reservations`;
            expect(row!.n).toBe("0"); // swept, not merely ignored
        } finally {
            await only.drop();
        }
    }, 60_000);
});

describeDb("the execution journal in Postgres", () => {
    it("remembers a signed transaction across a restart, and claims a key exactly once", async () => {
        // the record that must outlive the process that made it: a swap nothing remembers is money
        // moved with nothing to reconcile it against
        const only = await scratchSchema();
        try {
            const first = new PgJournal(only.sql);
            const claim = { key: "p1:0", symbol: "NVDAc", asset: "0x" + "11".repeat(20), usdcInMinor: 1_000_000n };
            expect((await first.reserve(claim)).status).toBe("pending");
            await first.recordSigned("p1:0", "0x" + "ab".repeat(32), "0x" + "cd".repeat(60));

            // a different instance, with nothing in memory
            const second = new PgJournal(only.sql);
            const seen = await second.find("p1:0");
            expect(seen?.status).toBe("sent");
            expect(seen?.rawTx).toBe("0x" + "cd".repeat(60));
            expect((await second.unresolved()).map((r) => r.key)).toEqual(["p1:0"]);

            // and it cannot be claimed a second time, whichever instance asks
            const again = await second.reserve({ ...claim, usdcInMinor: 9_000_000n });
            expect(again.status).toBe("sent");
            expect(again.usdcInMinor).toBe(1_000_000n); // the original claim, not the new amount

            await second.settle("p1:0", { status: "filled", amountOutMinor: 42n, gasUsed: 21_000n });
            expect(await first.unresolved()).toEqual([]);
            expect((await first.find("p1:0"))?.amountOutMinor).toBe(42n);
        } finally {
            await only.drop();
        }
    }, 60_000);

    it("counts the spend cap across instances, and forgets only what failed", async () => {
        const only = await scratchSchema();
        try {
            const j = new PgJournal(only.sql);
            const asset = "0x" + "11".repeat(20);
            await j.reserve({ key: "a", symbol: "NVDAc", asset, usdcInMinor: 1_000_000n });
            await j.reserve({ key: "b", symbol: "AAPLc", asset, usdcInMinor: 2_000_000n });
            expect(await j.committedUsdcMinor()).toBe(3_000_000n);

            // an unknown outcome still counts: it may well have spent the money
            await j.recordSigned("b", "0x" + "ef".repeat(32), "0x" + "ff".repeat(60));
            expect(await j.committedUsdcMinor()).toBe(3_000_000n);

            await j.settle("a", { status: "failed", detail: "reverted" });
            expect(await j.committedUsdcMinor()).toBe(2_000_000n);

            // a claim that never became a signature can be released
            await j.reserve({ key: "c", symbol: "MSFTc", asset, usdcInMinor: 500_000n });
            await j.release("c");
            expect(await j.committedUsdcMinor()).toBe(2_000_000n);
            // but one that was signed cannot
            await j.release("b");
            expect(await j.committedUsdcMinor()).toBe(2_000_000n);
            expect((await j.find("b"))?.status).toBe("sent");
        } finally {
            await only.drop();
        }
    }, 60_000);
});

describeDb("sessions in Postgres", () => {
    it("recognises a cookie the process did not issue itself", async () => {
        // the whole point: on a host that replaces the process between two requests, a session kept in
        // memory would be unknown to the next instance and sign-in would never stick
        const issuer = new PgSessionStore(scratch.sql);
        const { token } = await issuer.open("0xabc");
        const other = new PgSessionStore(scratch.sql);
        expect(await other.whoIs(token)).toBe("0xabc");
        await other.close(token);
        expect(await issuer.whoIs(token)).toBe(null);
    });

    it("spends a nonce exactly once, even when two requests race for it", async () => {
        const store = new PgSessionStore(scratch.sql);
        const { nonce, issuedAt } = await store.issueNonce();
        const [a, b] = await Promise.all([store.consumeNonce(nonce), store.consumeNonce(nonce)]);
        expect([a, b].filter((x) => x !== null)).toEqual([issuedAt]);
        expect(await store.consumeNonce(nonce)).toBe(null);
    });

    it("stops recognising an expired session and sweeps it away", async () => {
        let now = Date.parse("2026-11-21T00:00:00Z");
        const store = new PgSessionStore(scratch.sql, () => now);
        const { token } = await store.open("0xdef");
        expect(await store.count()).toBe(1);
        now += 8 * 60 * 60_000 + 1;
        expect(await store.whoIs(token)).toBe(null);
        expect(await store.count()).toBe(0);
        await store.issueNonce(); // a write sweeps, so the table does not grow without bound
        const [row] = await scratch.sql<{ n: string }[]>`select count(*)::text as n from sessions`;
        expect(row!.n).toBe("0");
    });

    it("expires a nonce that was left too long", async () => {
        let now = Date.parse("2026-11-21T00:00:00Z");
        const store = new PgSessionStore(scratch.sql, () => now);
        const { nonce } = await store.issueNonce();
        now += 5 * 60_000 + 1;
        expect(await store.consumeNonce(nonce)).toBe(null);
    });
});
