import { describe, it, expect } from "vitest";
import request from "supertest";
import {
    BASE_REGISTRY, MandateStore, parseUsdc as u,
    type MandateTerms, type SavedBrief, type Brief,
} from "@surplus/core";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { MemoryThrottle, callerKey, limit } from "../src/throttle";
import { JsonlReceiptStore } from "../src/receipts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = loadConfig({
    X402_PAY_TO: "0x" + "a".repeat(40),
    OWNER_TOKEN: "owner-token-for-tests-only",
    OWNER_ADDRESS: "0x" + "9".repeat(40),
} as NodeJS.ProcessEnv);

const terms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [{ id: "ai-compute", targetBps: 10_000 }],
    maxCompanyBps: 4000, investShareBps: 5000,
    maxTradeUsdc: u("1.00"), minTradeUsdc: u("0.05"), reserveTargetUsdc: u("2.00"),
    maxSlippageBps: 100, driftToleranceBps: 100, approvalExpirySeconds: 600,
};
const mandateFor = () => { const m = new MandateStore(); m.create(terms); return m; };
const brief: Brief = { id: "brief-test", createdAt: "2026-11-21T00:00:00.000Z", sources: [], themes: [], disclaimer: "d" };
const saved: SavedBrief = { file: "b.json", provider: "p", model: "m", brief, costUsdcMinor: 1n, costUsd: 0.01 };

describe("the ceiling on the free routes", () => {
    it("counts a window and refuses once it is used up", async () => {
        let now = 1_000_000;
        const t = new MemoryThrottle(() => now);
        for (let i = 0; i < 3; i += 1) expect(await t.allow("k", 3, 60_000)).toBe(true);
        expect(await t.allow("k", 3, 60_000)).toBe(false);

        // a different caller has their own allowance
        expect(await t.allow("other", 3, 60_000)).toBe(true);

        now += 60_001; // the window has passed
        expect(await t.allow("k", 3, 60_000)).toBe(true);
    });

    it("spends the allowance of whoever the proxy says is calling", () => {
        const req = (headers: Record<string, string>) => ({
            header: (n: string) => headers[n.toLowerCase()],
            socket: { remoteAddress: "10.0.0.1" },
        }) as unknown as Parameters<typeof callerKey>[0];

        expect(callerKey(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }))).toBe("203.0.113.7");
        expect(callerKey(req({}))).toBe("10.0.0.1");
    });

    it("lets the request through when the limiter itself fails", async () => {
        // the limit exists to stop abuse; it must not become a dependency that can take the API down
        const broken = { allow: async (): Promise<boolean> => { throw new Error("the database is unreachable"); } };
        const app = (await import("express")).default();
        app.get("/x", limit({ throttle: broken, name: "x", max: 1, windowMs: 1000 }), (_req, res) => {
            res.json({ ok: true });
        });
        const res = await request(app).get("/x");
        expect(res.status).toBe(200);
    });

    it("stops an anonymous caller minting sign-in nonces without end", async () => {
        // every nonce is a row, so an open route that writes one is a way to grow someone else's table
        const { app } = buildServer({
            config, mandates: mandateFor(), readBrief: () => saved, throttle: new MemoryThrottle(),
        });
        const codes: number[] = [];
        for (let i = 0; i < 25; i += 1) {
            codes.push((await request(app).post("/auth/nonce")).status);
        }
        expect(codes.filter((c) => c === 200).length).toBe(20);
        const refused = codes.filter((c) => c === 429);
        expect(refused.length).toBe(5);
    });

    it("limits receipt recovery the same way, and says when to come back", async () => {
        const receipts = new JsonlReceiptStore(join(mkdtempSync(join(tmpdir(), "surplus-throttle-")), "r.jsonl"));
        const { app } = buildServer({
            config, mandates: mandateFor(), readBrief: () => saved, receipts, throttle: new MemoryThrottle(),
        });
        let last = 200;
        for (let i = 0; i < 25; i += 1) {
            const res = await request(app).post("/receipt/nonce").send({ address: "0x" + "b".repeat(40) });
            last = res.status;
            if (res.status === 429) {
                expect(res.headers["retry-after"]).toBe("60");
                expect(res.body.error).toMatch(/too many requests/);
            }
        }
        expect(last).toBe(429);
    });

    it("does not throttle the routes that are already paid for or signed", async () => {
        const { app } = buildServer({
            config, mandates: mandateFor(), readBrief: () => saved, throttle: new MemoryThrottle(),
        });
        // payment is the limit on /brief, and the owner token on /mandate; neither should burn an allowance
        for (let i = 0; i < 30; i += 1) {
            expect((await request(app).get("/health")).status).toBe(200);
        }
        expect((await request(app).get("/brief")).status).toBe(402);
    });
});
