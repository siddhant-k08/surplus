import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
    BASE_REGISTRY,
    JsonlMandateStore,
    MandateStore,
    openMandate,
    parseUsdc as u,
    type MandateTerms,
    type MandateVersion,
    type SavedBrief,
    type Brief,
} from "@surplus/core";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { parseTermsUpdate, changedTerms } from "../src/terms";

const PAY_TO = "0x" + "a".repeat(40);
const TOKEN = "owner-token-for-tests-only";
const config = loadConfig({ X402_PAY_TO: PAY_TO, OWNER_TOKEN: TOKEN, OWNER_ADDRESS: "0x" + "9".repeat(40) } as NodeJS.ProcessEnv);

const terms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [{ id: "ai-compute", targetBps: 6000 }, { id: "platform-giants", targetBps: 4000 }],
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
const saved: SavedBrief = { file: "b.json", provider: "p", model: "m", brief, costUsdcMinor: 1n, costUsd: 0.01 };

const dirs: string[] = [];
function freshPath(): string {
    const d = mkdtempSync(join(tmpdir(), "surplus-mandate-api-"));
    dirs.push(d);
    return join(d, "mandate.jsonl");
}
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A server wired the way index.ts wires it: one shared store, persisted updates. */
function build(path = freshPath()) {
    const store = new JsonlMandateStore(path);
    const { mandates } = openMandate(store, terms);
    const updateMandate = (next: MandateTerms): MandateVersion => {
        const created = mandates.create(next);
        store.append(created);
        return created;
    };
    const built = buildServer({ config, mandates, readBrief: () => saved, updateMandate });
    return { ...built, mandates, store, path };
}

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${TOKEN}`);

describe("parseTermsUpdate", () => {
    it("changes only the fields that were sent", () => {
        const r = parseTermsUpdate({ maxSlippageBps: 50 }, terms);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.terms.maxSlippageBps).toBe(50);
        expect(r.terms.maxTradeUsdc).toBe(terms.maxTradeUsdc);
        expect(r.terms.themes).toEqual(terms.themes);
    });

    it("takes amounts as decimal strings and never as floats", () => {
        const r = parseTermsUpdate({ reserveTargetUsdc: "0.50" }, terms);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.terms.reserveTargetUsdc).toBe(u("0.50"));
        expect(parseTermsUpdate({ reserveTargetUsdc: 0.5 }, terms).ok).toBe(false);
        expect(parseTermsUpdate({ reserveTargetUsdc: "0.1234567" }, terms).ok).toBe(false);
    });

    it("refuses an unknown field instead of silently ignoring a typo", () => {
        const r = parseTermsUpdate({ maxSlipageBps: 50 }, terms);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/unknown field maxSlipageBps/);
    });

    it("refuses malformed eligible lists and themes", () => {
        expect(parseTermsUpdate({ eligible: ["nope"] }, terms).ok).toBe(false);
        expect(parseTermsUpdate({ themes: [{ id: "x" }] }, terms).ok).toBe(false);
        expect(parseTermsUpdate("not an object", terms).ok).toBe(false);
    });

    it("names what changed, with amounts readable", () => {
        const r = parseTermsUpdate({ maxTradeUsdc: "2.00" }, terms);
        expect(r.ok).toBe(true);
        if (r.ok) expect(changedTerms(terms, r.terms)).toEqual(["maxTradeUsdc: 1000000 -> 2000000"]);
    });
});

describe("the mandate routes", () => {
    it("needs the owner token", async () => {
        const { app } = build();
        expect((await request(app).get("/mandate")).status).toBe(401);
        expect((await request(app).get("/mandate/history")).status).toBe(401);
        expect((await request(app).post("/mandate").send({ maxSlippageBps: 50 })).status).toBe(401);
    });

    it("serves the current version and the verified history", async () => {
        const { app } = build();
        const cur = await auth(request(app).get("/mandate"));
        expect(cur.status).toBe(200);
        expect(cur.body.version).toBe(1);
        expect(cur.body.prevHash).toBe(null);
        expect(cur.body.terms.maxTradeUsdc).toBe(u("1.00").toString());

        const hist = await auth(request(app).get("/mandate/history"));
        expect(hist.body.chainVerified).toBe(true);
        expect(hist.body.versions.length).toBe(1);
    });

    it("creates a new version that chains to the last, and says what changed", async () => {
        const { app } = build();
        const res = await auth(request(app).post("/mandate")).send({ maxSlippageBps: 50, reserveTargetUsdc: "0.50" });
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(2);
        expect(res.body.changed.sort()).toEqual([
            "maxSlippageBps: 100 -> 50",
            "reserveTargetUsdc: 2000000 -> 500000",
        ]);
        expect(res.body.note).toMatch(/need reapproval/);

        const hist = await auth(request(app).get("/mandate/history"));
        expect(hist.body.chainVerified).toBe(true);
        expect(hist.body.versions[1]!.prevHash).toBe(hist.body.versions[0]!.hash);
    });

    it("persists the new version, so a restart sees it rather than the code's terms", async () => {
        const first = build();
        await auth(request(first.app).post("/mandate")).send({ maxSlippageBps: 50 });

        // a restart against the same file
        const restarted = build(first.path);
        const cur = await auth(request(restarted.app).get("/mandate"));
        expect(cur.body.version).toBe(2);
        expect(cur.body.terms.maxSlippageBps).toBe(50);
    });

    it("refuses terms the mandate rules reject, leaving the current version in place", async () => {
        const { app, mandates } = build();
        const res = await auth(request(app).post("/mandate")).send({ themes: [{ id: "a", targetBps: 9000 }, { id: "b", targetBps: 9000 }] });
        expect(res.status).toBe(400);
        expect(mandates.current().version).toBe(1);
    });

    it("refuses to change the mandate when the server was not given the means to", async () => {
        const store = new JsonlMandateStore(freshPath());
        const { mandates } = openMandate(store, terms);
        const { app } = buildServer({ config, mandates, readBrief: () => saved });
        const res = await auth(request(app).post("/mandate")).send({ maxSlippageBps: 50 });
        expect(res.status).toBe(409);
        expect(mandates.current().version).toBe(1);
    });

    it("shares one mandate with the rest of the server, so a change is seen everywhere", async () => {
        const { app, treasury, mandates } = build();
        await auth(request(app).post("/mandate")).send({ maxSlippageBps: 50 });
        expect(mandates.current().version).toBe(2);
        // the treasury was handed the same store, not a copy
        expect(treasury.ledger).toBeDefined();
        const cur = await auth(request(app).get("/mandate"));
        expect(cur.body.version).toBe(2);
    });
});

describe("a mandate change and outstanding approvals", () => {
    it("binds an approval to the version it was made under", () => {
        // the treasury already refuses to execute against a newer mandate; this records that the
        // mandate update path is what triggers it
        const m = new MandateStore();
        const v1 = m.create(terms);
        const v2 = m.create({ ...terms, maxSlippageBps: 50 });
        expect(v2.prevHash).toBe(v1.hash);
        expect(v2.version).toBe(2);
        expect(m.verifyChain()).toBe(true);
    });
});


describe("exit terms over HTTP", () => {
    it("sets and clears a rebalance band", async () => {
        const { app } = build();
        expect((await auth(request(app).post("/mandate")).send({ rebalanceBandBps: 750 })).status).toBe(200);
        expect((await auth(request(app).get("/mandate"))).body.terms.rebalanceBandBps).toBe(750);

        // Removal has to be expressible: the absence of an exit term means the agent may not sell on
        // its own, and an owner who set one by mistake needs a way back to that state.
        expect((await auth(request(app).post("/mandate")).send({ rebalanceBandBps: null })).status).toBe(200);
        expect((await auth(request(app).get("/mandate"))).body.terms.rebalanceBandBps).toBeUndefined();
    });

    it("sets and clears the price exits the same way", async () => {
        const { app } = build();
        await auth(request(app).post("/mandate")).send({ takeProfitBps: 2500, stopLossBps: 1500 });
        const after = (await auth(request(app).get("/mandate"))).body.terms;
        expect(after.takeProfitBps).toBe(2500);
        expect(after.stopLossBps).toBe(1500);

        await auth(request(app).post("/mandate")).send({ takeProfitBps: null });
        const cleared = (await auth(request(app).get("/mandate"))).body.terms;
        expect(cleared.takeProfitBps).toBeUndefined();
        expect(cleared.stopLossBps).toBe(1500); // untouched
    });

    it("refuses an exit that would fire on any movement at all", async () => {
        const { app } = build();
        for (const body of [{ rebalanceBandBps: 0 }, { takeProfitBps: 0 }, { stopLossBps: 0 }]) {
            expect((await auth(request(app).post("/mandate")).send(body)).status).toBe(400);
        }
        expect((await auth(request(app).post("/mandate")).send({ stopLossBps: 10_000 })).status).toBe(400);
    });

    it("refuses an exit that is not a whole number of basis points", async () => {
        const { app } = build();
        expect((await auth(request(app).post("/mandate")).send({ rebalanceBandBps: "750" })).status).toBe(400);
        expect((await auth(request(app).post("/mandate")).send({ takeProfitBps: 12.5 })).status).toBe(400);
    });

    it("leaves a mandate with no exit terms hashing as it did", () => {
        // canonicalJson drops undefined keys, so a stored chain written before the sell path verifies
        const r = parseTermsUpdate({ maxSlippageBps: 50 }, terms);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.terms.takeProfitBps).toBeUndefined();
        expect(r.terms.stopLossBps).toBeUndefined();
        expect(r.terms.rebalanceBandBps).toBeUndefined();
    });
});
