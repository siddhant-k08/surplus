import { describe, it, expect } from "vitest";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import {
    BASE_REGISTRY, MandateStore, parseUsdc as u,
    type MandateTerms, type SavedBrief, type Brief,
} from "@surplus/core";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { SessionStore, SESSION_COOKIE, LOGIN_TYPES, readCookie, verifyLogin } from "../src/session";

const OWNER = privateKeyToAccount(("0x" + "33".repeat(32)) as `0x${string}`);
const IMPOSTOR = privateKeyToAccount(("0x" + "44".repeat(32)) as `0x${string}`);
const TOKEN = "owner-token-for-tests-only";
const CHAIN = 84532;

const config = loadConfig({
    X402_PAY_TO: "0x" + "a".repeat(40),
    OWNER_TOKEN: TOKEN,
    OWNER_ADDRESS: OWNER.address,
    COOKIE_SECURE: "false",
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

const build = () => buildServer({ config, mandates: mandateFor(), readBrief: () => saved });

/** Signs whatever /auth/nonce offered, the way a wallet would. */
async function signOffer(
    account: typeof OWNER,
    offered: { domain: { name: string; version: string; chainId: number }; message: Record<string, string> },
) {
    return account.signTypedData({
        domain: offered.domain,
        types: LOGIN_TYPES,
        primaryType: "Login",
        message: {
            statement: offered.message.statement!,
            address: offered.message.address as `0x${string}`,
            nonce: offered.message.nonce!,
            issuedAt: BigInt(offered.message.issuedAt!),
        },
    });
}

/** The full handshake: ask for a nonce, sign it, exchange it for a session cookie. */
async function signIn(app: Parameters<typeof request>[0], account = OWNER) {
    const offered = await request(app).post("/auth/nonce");
    const signature = await signOffer(account, offered.body);
    const verified = await request(app)
        .post("/auth/verify")
        .send({ signature, nonce: offered.body.message.nonce });
    const setCookie = verified.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie ?? "");
    return { offered, verified, cookie };
}

describe("the sign-in handshake", () => {
    it("exchanges an owner signature for a session cookie", async () => {
        const { app } = build();
        const { verified, cookie } = await signIn(app);
        expect(verified.status).toBe(200);
        expect(verified.body.address.toLowerCase()).toBe(OWNER.address.toLowerCase());
        expect(cookie).toContain(`${SESSION_COOKIE}=`);
        expect(cookie).toContain("HttpOnly");
        expect(cookie.toLowerCase()).toContain("samesite=strict");
    });

    it("opens the owner routes to a signed-in browser with no token", async () => {
        const { app } = build();
        expect((await request(app).get("/mandate")).status).toBe(401);
        const { cookie } = await signIn(app);
        const res = await request(app).get("/mandate").set("Cookie", cookie);
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(1);
    });

    it("still lets a script in with the owner token", async () => {
        const { app } = build();
        const res = await request(app).get("/mandate").set("Authorization", `Bearer ${TOKEN}`);
        expect(res.status).toBe(200);
    });

    it("refuses a signature from anyone but the configured owner", async () => {
        const { app } = build();
        const offered = await request(app).post("/auth/nonce");
        const signature = await signOffer(IMPOSTOR, offered.body);
        const res = await request(app).post("/auth/verify").send({ signature, nonce: offered.body.message.nonce });
        expect(res.status).toBe(401);
        expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("spends a nonce once, so a captured signature cannot be replayed", async () => {
        const { app } = build();
        const offered = await request(app).post("/auth/nonce");
        const signature = await signOffer(OWNER, offered.body);
        const nonce = offered.body.message.nonce;

        const first = await request(app).post("/auth/verify").send({ signature, nonce });
        expect(first.status).toBe(200);
        const replay = await request(app).post("/auth/verify").send({ signature, nonce });
        expect(replay.status).toBe(400);
        expect(replay.body.error).toMatch(/expired or was already used/);
    });

    it("refuses a nonce it never issued", async () => {
        const { app } = build();
        const res = await request(app).post("/auth/verify").send({ signature: "0x" + "11".repeat(65), nonce: "made-up" });
        expect(res.status).toBe(400);
    });

    it("requires both a signature and a nonce", async () => {
        const { app } = build();
        expect((await request(app).post("/auth/verify").send({})).status).toBe(400);
        expect((await request(app).post("/auth/verify").send({ nonce: "x" })).status).toBe(400);
    });

    it("reports who is signed in, and forgets them on sign out", async () => {
        const { app } = build();
        expect((await request(app).get("/auth/me")).body.signedIn).toBe(false);

        const { cookie } = await signIn(app);
        const me = await request(app).get("/auth/me").set("Cookie", cookie);
        expect(me.body.signedIn).toBe(true);
        expect(me.body.address.toLowerCase()).toBe(OWNER.address.toLowerCase());

        await request(app).post("/auth/logout").set("Cookie", cookie);
        expect((await request(app).get("/auth/me").set("Cookie", cookie)).body.signedIn).toBe(false);
        expect((await request(app).get("/mandate").set("Cookie", cookie)).status).toBe(401);
    });

    it("never puts the owner token in the cookie", async () => {
        const { app } = build();
        const { cookie } = await signIn(app);
        expect(cookie).not.toContain(TOKEN);
    });
});

describe("session mechanics", () => {
    it("expires a nonce that was left too long", () => {
        let now = 1_000_000;
        const store = new SessionStore(() => now);
        const { nonce } = store.issueNonce();
        now += 5 * 60_000 + 1;
        expect(store.consumeNonce(nonce)).toBe(null);
    });

    it("expires a session and stops recognising its token", () => {
        let now = 1_000_000;
        const store = new SessionStore(() => now);
        const { token } = store.open("0xabc");
        expect(store.whoIs(token)).toBe("0xabc");
        now += 8 * 60 * 60_000 + 1;
        expect(store.whoIs(token)).toBe(null);
        expect(store.size).toBe(0);
    });

    it("reads one cookie out of a header without a parser", () => {
        expect(readCookie("a=1; surplus_session=abc; b=2", SESSION_COOKIE)).toBe("abc");
        expect(readCookie("other=1", SESSION_COOKIE)).toBe(null);
        expect(readCookie(undefined, SESSION_COOKIE)).toBe(null);
    });

    it("refuses a malformed signature without reaching the verifier", async () => {
        const v = await verifyLogin({
            signature: "nope", nonce: "n", issuedAt: 1, chainId: CHAIN, ownerAddress: OWNER.address,
        });
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.reason).toMatch(/65 bytes/);
    });
});

describe("every route is actually mounted", () => {
    // A brace in the wrong place once nested paymentMiddleware and every route after it inside the
    // /auth/me handler. Types still compiled and the owner routes still answered, so only the public
    // routes went missing. This asserts the shape of the server, not one handler.
    it("answers on the public, paid and owner routes at once", async () => {
        const { app } = build();
        const seen: Record<string, number> = {};
        for (const path of ["/health", "/brief", "/ledger", "/auth/me", "/mandate"]) {
            seen[path] = (await request(app).get(path)).status;
        }
        expect(seen["/health"]).toBe(200);   // free
        expect(seen["/brief"]).toBe(402);    // paid, so a challenge rather than a 404
        expect(seen["/auth/me"]).toBe(200);  // free
        expect(seen["/ledger"]).toBe(401);   // owner-gated by default
        expect(seen["/mandate"]).toBe(401);  // owner-gated
        // the failure this catches is a 404, which means the route never registered
        expect(Object.values(seen)).not.toContain(404);
    });
});
