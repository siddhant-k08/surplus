import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import {
    Ledger,
    JsonlLedgerStore,
    reconcileInternal,
    parseUsdc as u,
    BASE_REGISTRY,
    type LedgerTx,
    type Leg,
    type LegQuotes,
    type Quote,
    MandateStore,
    type MandateTerms,
    type SavedBrief,
    type TokenRecord,
    openLedger,
    themeHoldings,
    MemoryProposalStore,
    type ProposalStore,
} from "@surplus/core";
import { privateKeyToAccount } from "viem/accounts";
import { approvalTypedData } from "@surplus/core";
import { InvestingEngine, UNATTRIBUTED, type MarketData } from "../src/investing";
import { verifyApprovalSignature } from "../src/signature";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";

const PAY_TO = "0x" + "a".repeat(40);
const TOKEN = "owner-token-for-tests-only";
const env = { X402_PAY_TO: PAY_TO, OWNER_TOKEN: TOKEN, OPENING_FLOAT_USDC: "1.00", OWNER_ADDRESS: "0x" + "9".repeat(40) } as NodeJS.ProcessEnv;
const config = loadConfig(env);

const NVDA = BASE_REGISTRY.find((r) => r.symbol === "NVDAc")!;
const MSFT = BASE_REGISTRY.find((r) => r.symbol === "MSFTc")!;

const terms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [{ id: "ai-compute", targetBps: 10000 }],
    maxCompanyBps: 6000,
    investShareBps: 5000,
    maxTradeUsdc: u("1.00"),
    minTradeUsdc: u("0.05"),
    reserveTargetUsdc: u("0.50"),
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


const DECIMALS = 18;
const NAV = 100; // dollars per whole token
const PRICE = 100_000_000n; // USDC minor units per whole token, matching NAV so the deviation gate passes

const token = (r: { symbol: string; address: string }): TokenRecord => ({
    address: r.address.toLowerCase(),
    symbol: r.symbol,
    name: r.symbol,
    decimals: DECIMALS,
    isin: null,
    multiplier: 1,
    pausedFeatures: [],
    navPrice: NAV,
    navUpdatedAt: new Date().toISOString(),
    totalSupply: null,
});

/**
 * Quotes shaped the way the real aggregator returns them, so the pre-trade gates do real work here.
 * `priceOf` derives the price as amountIn * 10^decimals / amountOut, and the freshness gate reads
 * `timestamp` in unix seconds, so both have to be consistent or the gates correctly block.
 */
const quoteFor = (asset: string, usdcIn: bigint, now: Date): Quote => ({
    tokenIn: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tokenOut: asset,
    amountIn: usdcIn,
    amountOut: (usdcIn * 10n ** BigInt(DECIMALS)) / PRICE,
    amountInUsd: 1,
    amountOutUsd: 1,
    gasUsd: 0.003,
    l1FeeUsd: null,
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    routeId: "r1",
    timestamp: Math.floor(now.getTime() / 1000),
    routeSummary: {},
});

/**
 * A sale quote, shaped the way the aggregator really returns one: token in, USDC out.
 *
 * The direction matters to the gates, not only to the price. A sale quoted in the buy shape reads as a
 * price of tokens per dollar, which against NAV looks like a deviation of thousands of basis points.
 */
const saleQuoteFor = (asset: string, unitsIn: bigint, now: Date): Quote => ({
    tokenIn: asset,
    tokenOut: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amountIn: unitsIn,
    amountOut: (unitsIn * PRICE) / 10n ** BigInt(DECIMALS),
    amountInUsd: 1,
    amountOutUsd: 1,
    gasUsd: 0.003,
    l1FeeUsd: null,
    routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    routeId: "r1",
    timestamp: Math.floor(now.getTime() / 1000),
    routeSummary: {},
});

const market = async (): Promise<MarketData> => {
    const now = new Date();
    return {
        trusted: [token(NVDA), token(MSFT)],
        liquidity: new Map([[NVDA.address.toLowerCase(), 5], [MSFT.address.toLowerCase(), 5]]),
        quote: async (legs: readonly Leg[]): Promise<LegQuotes> => {
            const out: LegQuotes = { prices: new Map(), quotes: new Map(), errors: new Map() };
            const totals = new Map<string, { amountIn: bigint; sell: boolean }>();
            for (const l of legs) {
                const key = l.asset.toLowerCase();
                const sell = l.side === "sell";
                const row = totals.get(key);
                const add = sell ? (l.unitsIn ?? 0n) : l.usdcIn;
                if (row === undefined) totals.set(key, { amountIn: add, sell });
                else row.amountIn += add;
            }
            for (const [asset, { amountIn, sell }] of totals) {
                out.prices.set(asset, PRICE);
                out.quotes.set(asset, sell ? saleQuoteFor(asset, amountIn, now) : quoteFor(asset, amountIn, now));
            }
            return out;
        },
    };
};

/** A brief whose only theme has two well-supported fits, so an allocation is possible. */
const savedBrief = (): SavedBrief => ({
    file: "b.json",
    provider: "gemini",
    model: "test",
    costUsdcMinor: u("0.02"),
    costUsd: 0.02,
    brief: {
        id: "brief-test",
        createdAt: "2026-11-21T00:00:00.000Z",
        disclaimer: "Informational only, not investment advice.",
        sources: [{
            id: "s1", tier: 1, title: "10-K", publisher: "SEC EDGAR",
            url: "https://www.sec.gov/x", publishedAt: "2026-01-01",
            retrievedAt: "2026-11-21T00:00:00.000Z", excerpt: "data center revenue grew",
        }],
        themes: [{
            themeId: "ai-compute",
            gap: false,
            claims: [{
                id: "ai-compute:c1", type: "fact", text: "NVIDIA sells data center platforms.",
                sourceIds: ["s1"], quotes: [{ sourceId: "s1", text: "data center revenue grew" }],
            }],
            fits: [
                { asset: NVDA.address, symbol: "NVDAc", fit: 5, evidence: 2, claimIds: ["ai-compute:c1"] },
                { asset: MSFT.address, symbol: "MSFTc", fit: 4, evidence: 2, claimIds: ["ai-compute:c1"] },
            ],
        }],
    },
});

/** A sales ledger holding real revenue, as the paid endpoint would have written it. */
function salesLedger(amount: string, mode: "sim" | "testnet" | "mainnet" = "testnet"): readonly LedgerTx[] {
    const l = new Ledger();
    l.post({
        type: "PAYMENT_RECEIVED", mode, at: new Date("2026-11-21T00:00:00Z"),
        idempotencyKey: "pay:x402:0xaaa", txHash: "0xaaa", briefId: "brief-test",
        lines: [
            { account: "cash.operating", amount: u(amount) },
            { account: "revenue.research", amount: -u(amount) },
        ],
    });
    return l.all();
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "surplus-invest-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A throwaway owner wallet. Signing in tests means the whole signature path is exercised for real
// rather than stubbed, which is the only way to know the verification actually rejects anything.
const OWNER_KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const ownerAccount = privateKeyToAccount(OWNER_KEY);
const IMPOSTOR_KEY = ("0x" + "22".repeat(32)) as `0x${string}`;
const impostor = privateKeyToAccount(IMPOSTOR_KEY);
const CHAIN_ID = 84532;

const engineFor = async (revenue = "3.00", store?: JsonlLedgerStore, openingFloat = u("1.00"), ownerAddress = ownerAccount.address) =>
    new InvestingEngine({
        mode: "sim",
        openingFloat,
        mandates: mandateFor(terms),
        readBrief: savedBrief,
        allBriefs: () => [savedBrief()],
        salesLedger: () => salesLedger(revenue),
        market,
        chainId: CHAIN_ID,
        verifyApproval: ({ approval, signature }) =>
            verifyApprovalSignature({ approval, signature, chainId: CHAIN_ID, ownerAddress }),
        ...(store ? { ledger: await openLedger(store), sink: store } : {}),
    });

/** Signs the payload the engine offered, the way an owner's wallet would. */
async function signOffer(
    account: typeof ownerAccount,
    toSign: unknown,
    chainId = CHAIN_ID,
): Promise<`0x${string}`> {
    const td = toSign as { message: Record<string, string>; domain: { chainId: number } };
    return account.signTypedData({
        domain: { name: "Surplus", version: "1", chainId },
        types: approvalTypedData(
            {
                proposalHash: td.message.proposalHash!,
                mandateVersion: Number(td.message.mandateVersion),
                mandateHash: td.message.mandateHash!,
                maxUsdcIn: BigInt(td.message.maxUsdcIn!),
                expiresAt: new Date(Number(td.message.expiresAt) * 1000).toISOString(),
            },
            chainId,
        ).types,
        primaryType: "Approval",
        message: {
            proposalHash: td.message.proposalHash as `0x${string}`,
            mandateVersion: BigInt(td.message.mandateVersion!),
            mandateHash: td.message.mandateHash as `0x${string}`,
            maxUsdcIn: BigInt(td.message.maxUsdcIn!),
            expiresAt: BigInt(td.message.expiresAt!),
        },
    });
}

describe("the investing engine", () => {
    it("mirrors real revenue, books the brief cost, and settles", async () => {
        const e = await engineFor("3.00");
        const r = await e.syncRevenue();
        expect(r.sales).toBe(1);
        expect(r.revenue).toBe(u("3.00"));
        // 3.00 - 0.02 cost = 2.98 net, 0.50 to reserve, half of 2.48 investable
        expect(r.investable).toBe(u("1.24"));
        expect(e.treasury.ledger.balance("surplus.investable")).toBe(u("1.24"));
    });

    it("mirrors only what it has not already seen", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const n = e.treasury.ledger.all().length;
        const again = await e.syncRevenue();
        expect(again.revenue).toBe(u("3.00"));
        expect(e.treasury.ledger.all().length).toBe(n); // nothing double booked
        expect(e.treasury.ledger.balance("revenue.research")).toBe(-u("3.00"));
    });

    it("keeps the mirrored entry traceable to the real transaction", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const payment = e.treasury.ledger.all().find((x) => x.type === "PAYMENT_RECEIVED")!;
        expect(payment.memo).toContain("mirrors real sale 0xaaa");
        expect(payment.txHash).toBe("0xaaa"); // so a restart knows this sale was already mirrored
        expect(payment.briefId).toBe("brief-test"); // revenue follows the brief that was sold
        expect(payment.mode).toBe("sim"); // the investing book is simulated; the real one is not
    });

    it("refuses to propose when nothing is investable", async () => {
        const e = await engineFor("0.01"); // less than the 0.02 brief cost
        await e.syncRevenue();
        const r = await e.propose("p1");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/nothing investable/);
    });

    it("proposes without approving, and reports the swap plan and hashes", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const r = await e.propose("p1");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.view.state).toBe("PROPOSED");
        expect(r.view.legs.length).toBeGreaterThan(0);
        expect(r.view.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(r.view.mandateVersion).toBe(1);
        // the plan must spend exactly what the legs spend
        const legTotal = r.view.legs.reduce((a, l) => a + BigInt(l.usdcIn), 0n);
        const swapTotal = r.view.swaps.reduce((a, s) => a + BigInt(s.usdcIn), 0n);
        expect(swapTotal).toBe(legTotal);
        expect(r.view.totalUsdcIn).toBe(legTotal.toString());
    });

    it("will not execute a proposal that was never approved", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        await e.propose("p1");
        await expect(e.execute("p1")).rejects.toThrow(/expected APPROVED/);
    });

    it("refuses to approve without the owner's signature", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        await e.propose("p1");
        const r = await e.approve("p1", "0x" + "00".repeat(65));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/not a valid owner approval|could not be verified/);
        await expect(e.execute("p1")).rejects.toThrow(/expected APPROVED/);
    });

    it("refuses a signature from anyone but the owner", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const p = await e.propose("p1");
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        const r = await e.approve("p1", await signOffer(impostor, p.toSign));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/not a valid owner approval/);
    });

    it("refuses a signature made for a different chain", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const p = await e.propose("p1");
        if (!p.ok) return;
        // same owner, same payload, wrong chain id: a testnet signature must not work on mainnet
        const r = await e.approve("p1", await signOffer(ownerAccount, p.toSign, 8453));
        expect(r.ok).toBe(false);
    });

    it("refuses a signature over a tampered ceiling", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const p = await e.propose("p1");
        if (!p.ok) return;
        const td = p.toSign as { message: Record<string, string> };
        const raised = { message: { ...td.message, maxUsdcIn: (BigInt(td.message.maxUsdcIn!) * 10n).toString() } };
        const r = await e.approve("p1", await signOffer(ownerAccount, raised));
        expect(r.ok).toBe(false);
    });

    it("refuses to approve a proposal that was never offered", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const r = await e.approve("nope", "0x" + "11".repeat(65));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/no approval payload was offered/);
    });

    it("refuses every approval when the server cannot verify signatures at all", async () => {
        const e = new InvestingEngine({
            mode: "sim",
            openingFloat: u("1.00"),
            mandates: mandateFor(terms),
            readBrief: savedBrief,
            allBriefs: () => [savedBrief()],
            salesLedger: () => salesLedger("3.00"),
            market,
            chainId: CHAIN_ID,
        });
        await e.syncRevenue();
        await e.propose("p1");
        const r = await e.approve("p1", "0x" + "11".repeat(65));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/cannot verify owner signatures/);
    });

    it("runs propose, approve and execute as three separate steps", async () => {
        const e = await engineFor("3.00");
        await e.syncRevenue();
        const p = await e.propose("p1");
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        const a = await e.approve("p1", await signOffer(ownerAccount, p.toSign));
        expect(a.ok).toBe(true);
        if (a.ok) expect(a.signer.toLowerCase()).toBe(ownerAccount.address.toLowerCase());
        const x = await e.execute("p1");
        expect(x.ok).toBe(true);
        if (x.ok) {
            expect(x.simulated).toBe(true);
            expect(x.fills.length).toBeGreaterThan(0);
        }
        expect(e.treasury.ledger.all().some((l) => l.type === "PURCHASE_SETTLED")).toBe(true);
        expect(e.treasury.ledger.all().every((l) => l.mode === "sim")).toBe(true);
    });

    it("persists the investing book and reloads it", async () => {
        const store = new JsonlLedgerStore(join(dir, "invest.jsonl"));
        const first = await engineFor("3.00", store);
        await first.syncRevenue();
        const investable = first.treasury.ledger.balance("surplus.investable");

        const second = await engineFor("3.00", store);
        expect(second.treasury.ledger.balance("surplus.investable")).toBe(investable);
        // the restored engine knows the revenue was already mirrored
        const n = second.treasury.ledger.all().length;
        await second.syncRevenue();
        expect(second.treasury.ledger.all().length).toBe(n);
    });
});

describe("owner working capital", () => {
    it("records the owner's float so the books do not report money that was never there", async () => {
        const e = await engineFor("0.01"); // revenue below the brief cost
        await e.syncRevenue();
        expect(e.treasury.ledger.balance("cash.operating")).toBeGreaterThan(0n);
        expect(reconcileInternal(e.treasury.ledger).ok).toBe(true);
        const opening = e.treasury.ledger.all().find((x) => x.type === "OPENING_BALANCE")!;
        expect(opening.memo).toContain("owner-provided working capital (simulated)");
    });

    it("without a float, a brief costing more than it earned shows up as negative cash", async () => {
        // this is the state that reconciliation is supposed to catch, not paper over
        const e = await engineFor("0.01", undefined, 0n);
        await e.syncRevenue();
        expect(e.treasury.ledger.balance("cash.operating")).toBeLessThan(0n);
        expect(reconcileInternal(e.treasury.ledger).issues).toContain("negative balance on cash.operating");
    });

    it("does not fund the agent twice across a restart", async () => {
        const store = new JsonlLedgerStore(join(dir, "invest.jsonl"));
        await (await engineFor("3.00", store)).syncRevenue();
        const second = await engineFor("3.00", store);
        expect(second.treasury.ledger.all().filter((x) => x.type === "OPENING_BALANCE").length).toBe(1);
        expect(second.treasury.ledger.balance("equity.opening")).toBe(-u("1.00"));
    });
});

describe("the owner routes", () => {
    // the server config must name the same owner the test engine verifies against
    const signedConfig = loadConfig({
        X402_PAY_TO: PAY_TO, OWNER_TOKEN: TOKEN, OWNER_ADDRESS: ownerAccount.address,
    } as NodeJS.ProcessEnv);
    const build = async () => buildServer({ config: signedConfig, mandates: mandateFor(terms), readBrief: savedBrief, engine: await engineFor("3.00") });
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${TOKEN}`);

    it("refuses every owner route without a valid token", async () => {
        const { app } = await build();
        for (const path of ["/mandate", "/invest/ledger", "/invest/proposals"]) {
            expect((await request(app).get(path)).status).toBe(401);
            expect((await request(app).get(path).set("Authorization", "Bearer wrong")).status).toBe(401);
        }
        for (const path of ["/invest/sync", "/invest/propose", "/invest/approve", "/invest/execute"]) {
            expect((await request(app).post(path).send({ id: "p1", signature: "0x" + "11".repeat(65) })).status).toBe(401);
        }
    });

    it("does not leak whether a token is merely the wrong length", async () => {
        const { app } = await build();
        const short = await request(app).get("/mandate").set("Authorization", "Bearer x");
        const wrong = await request(app).get("/mandate").set("Authorization", `Bearer ${"y".repeat(TOKEN.length)}`);
        expect(short.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(short.body).toEqual(wrong.body);
    });

    it("serves the mandate with its version and hash", async () => {
        const { app } = await build();
        const res = await auth(request(app).get("/mandate"));
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(1);
        expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(res.body.terms.reserveTargetUsdc).toBe(u("0.50").toString());
    });

    it("says how much more revenue a trade would need, not just that there is none", async () => {
        // "nothing to invest" is the agent behaving correctly, and on its own it does not tell an owner
        // whether that is one sale away or a hundred
        const { app } = await build();
        const poor = await auth(request(app).post("/invest/sync"));
        expect(poor.status).toBe(200);

        const engine = await engineFor("0.01"); // a cent earned against a brief that cost more
        const { app: thin } = buildServer({ config: signedConfig, mandates: mandateFor(terms), readBrief: savedBrief, engine });
        const res = await auth(request(thin).post("/invest/sync"));
        expect(res.body.investableUsdcMinor).toBe("0");
        expect(res.body.gap.canInvest).toBe(false);
        expect(BigInt(res.body.gap.revenueNeededUsdcMinor)).toBeGreaterThan(0n);
        // the parts have to add up to the total, or the explanation is not the same arithmetic
        expect(BigInt(res.body.gap.revenueNeededUsdcMinor)).toBe(
            BigInt(res.body.gap.shortfallUsdcMinor)
            + BigInt(res.body.gap.reserveGapUsdcMinor)
            + BigInt(res.body.gap.surplusNeededUsdcMinor),
        );

        const ledger = await auth(request(thin).get("/invest/ledger"));
        expect(ledger.body.gap.revenueNeededUsdcMinor).toBe(res.body.gap.revenueNeededUsdcMinor);
    });

    it("reports that a trade is possible once there is enough investable", async () => {
        const { app } = await build(); // 3.00 of revenue, well past the reserve and the minimum trade
        const res = await auth(request(app).post("/invest/sync"));
        expect(res.body.gap.canInvest).toBe(true);
        expect(res.body.gap.revenueNeededUsdcMinor).toBe("0");
    });

    it("says what pressing execute would actually do", async () => {
        // config alone cannot answer this: INVEST_MODE=mainnet with no key still simulates, and an
        // owner about to approve a trade needs the real answer
        const { app } = await build();
        const none = await auth(request(app).get("/invest/execution"));
        expect(none.status).toBe(200);
        expect(none.body.willSendRealSwaps).toBe(false);
        expect(none.body.why).toMatch(/without an executor/);

        const ledger = await auth(request(app).get("/invest/ledger"));
        expect(ledger.body.simulatedFills).toBe(true);
    });

    it("reports the spend cap and anything left unresolved onchain", async () => {
        const { app } = buildServer({
            config: signedConfig,
            mandates: mandateFor(terms),
            readBrief: savedBrief,
            engine: await engineFor("3.00"),
            executionStatus: async () => ({
                willSendRealSwaps: true,
                address: "0x" + "ee".repeat(20),
                capUsdcMinor: u("5.00").toString(),
                spentUsdcMinor: u("1.00").toString(),
                remainingUsdcMinor: u("4.00").toString(),
                unresolved: [{ key: "p1:0", symbol: "NVDAc", txHash: "0x" + "ab".repeat(32), usdcInMinor: u("0.50").toString() }],
            }),
        });
        const res = await auth(request(app).get("/invest/execution"));
        expect(res.body.willSendRealSwaps).toBe(true);
        expect(res.body.remainingUsdcMinor).toBe(u("4.00").toString());
        expect(res.body.unresolved[0].symbol).toBe("NVDAc");

        // and the ledger stops claiming the fills are simulated
        const ledger = await auth(request(app).get("/invest/ledger"));
        expect(ledger.body.simulatedFills).toBe(false);
    });

    it("keeps execution status behind the owner gate", async () => {
        const { app } = await build();
        expect((await request(app).get("/invest/execution")).status).toBe(401);
        expect((await request(app).get("/invest/positions")).status).toBe(401);
    });

    it("says there is nothing to reconcile against the chain while fills are simulated", async () => {
        // claiming "reconciled" about swaps that never happened would be worse than saying nothing
        const { app } = await build();
        const res = await auth(request(app).get("/invest/positions"));
        expect(res.status).toBe(200);
        expect(res.body.checked).toBe(false);
        expect(res.body.why).toMatch(/nothing onchain/);
    });

    it("reports the books against the wallet when there is something onchain", async () => {
        const { app } = buildServer({
            config: signedConfig,
            mandates: mandateFor(terms),
            readBrief: savedBrief,
            engine: await engineFor("3.00"),
            positions: async () => ({
                ok: false,
                positions: [{
                    asset: "0xaaa", symbol: "NVDAc",
                    bookedUnits: 1_000n, heldUnits: 400n, differenceUnits: -600n, verdict: "short" as const,
                }],
                issues: ["NVDAc: short by 600"],
            }),
        });
        const res = await auth(request(app).get("/invest/positions"));
        expect(res.body.checked).toBe(true);
        expect(res.body.ok).toBe(false);
        expect(res.body.positions[0].verdict).toBe("short");
        expect(res.body.positions[0].bookedUnits).toBe("1000"); // a string, like every other amount
        expect(res.body.issues[0]).toMatch(/short by 600/);
    });

    it("walks sync, propose, approve, execute over HTTP", async () => {
        const { app } = await build();
        const sync = await auth(request(app).post("/invest/sync"));
        expect(sync.status).toBe(200);
        expect(sync.body.sales).toBe(1);

        const prop = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        expect(prop.status).toBe(200);
        expect(prop.body.state).toBe("PROPOSED");
        expect(prop.body.toSign.domain.chainId).toBe(CHAIN_ID);

        const exec0 = await auth(request(app).post("/invest/execute")).send({ id: "p1" });
        expect(exec0.status).toBe(409); // not approved yet

        // the token alone must not be enough to approve
        const noSig = await auth(request(app).post("/invest/approve")).send({ id: "p1" });
        expect(noSig.status).toBe(400);

        const appr = await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, prop.body.toSign) });
        expect(appr.status).toBe(200);
        expect(appr.body.approved).toBe(true);
        expect(appr.body.signer.toLowerCase()).toBe(ownerAccount.address.toLowerCase());

        const exec = await auth(request(app).post("/invest/execute")).send({ id: "p1" });
        expect(exec.status).toBe(200);
        expect(exec.body.simulated).toBe(true);
    });

    it("reports the investing ledger as reconciling, and labels the fills simulated", async () => {
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const prop = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, prop.body.toSign) });
        await auth(request(app).post("/invest/execute")).send({ id: "p1" });

        const res = await auth(request(app).get("/invest/ledger"));
        expect(res.status).toBe(200);
        expect(res.body.reconcile.ok).toBe(true);
        expect(res.body.simulatedFills).toBe(true);
        expect(res.body.entries.every((e: { mode: string }) => e.mode === "sim")).toBe(true);
    });

    it("publishes what the agent put behind its own research, with no token", async () => {
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const prop = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, prop.body.toSign) });
        const exec = await auth(request(app).post("/invest/execute")).send({ id: "p1" });
        expect(exec.status).toBe(200);

        // No Authorization header: a proof only the owner can read is not a proof.
        const res = await request(app).get("/catalogue/backing");
        expect(res.status).toBe(200);
        expect(res.body.briefs).toHaveLength(1);

        const brief = res.body.briefs[0];
        expect(brief.briefId).toBe("brief-test");
        expect(brief.themes).toHaveLength(1);
        expect(brief.themes[0].theme).toBe("ai-compute");
        // the fills were simulated, and the response has to say so rather than leave it to be assumed
        expect(brief.simulated).toBe(true);
        expect(brief.onchainFills).toBe(0);
        expect(brief.mode).toBe("sim");

        // every asset names itself from Base's registry, and the parts add to the headline
        const assets = brief.themes[0].assets as { symbol: string; usdcMinor: string }[];
        expect(assets.map((a) => a.symbol).sort()).toEqual(["MSFTc", "NVDAc"]);
        expect(assets.reduce((a, x) => a + BigInt(x.usdcMinor), 0n)).toBe(BigInt(brief.themes[0].usdcMinor));
        expect(BigInt(brief.usdcMinor)).toBe(BigInt(res.body.attributedUsdcMinor));
        expect(res.body.unattributed).toEqual({ usdcMinor: "0", fills: 0 });

        // what it spent is what the proposal said it would
        expect(BigInt(res.body.attributedUsdcMinor)).toBe(BigInt(prop.body.totalUsdcIn));
    });

    it("tells a reader nothing about costs, the reserve or the owner's float", async () => {
        // The route is public, so what it leaves out matters as much as what it carries. Everything in
        // the list below is in /invest/ledger, which needs the owner's token.
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const prop = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, prop.body.toSign) });
        await auth(request(app).post("/invest/execute")).send({ id: "p1" });

        const body = JSON.stringify((await request(app).get("/catalogue/backing")).body);
        for (const leak of ["expense", "reserve", "equity", "retained", "cash.operating", "revenue"]) {
            expect(body).not.toContain(leak);
        }
    });

    it("answers empty rather than erroring before the agent has invested anything", async () => {
        const { app } = await build();
        const res = await request(app).get("/catalogue/backing");
        expect(res.status).toBe(200);
        expect(res.body.briefs).toEqual([]);
        expect(res.body.attributedUsdcMinor).toBe("0");
        expect(res.body.totalUsdcMinor).toBe("0");
    });

    it("sells a position on the owner's request, through the same signature and drift gate", async () => {
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const bought = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, bought.body.toSign) });
        await auth(request(app).post("/invest/execute")).send({ id: "p1" });

        const holdings = await auth(request(app).get("/invest/holdings"));
        expect(holdings.status).toBe(200);
        const nvda = holdings.body.positions.find((p: { symbol: string }) => p.symbol === "NVDAc");
        expect(nvda.sellable).toBe(true);
        expect(BigInt(nvda.units)).toBeGreaterThan(0n);

        // no exit rule is set, so the owner naming the position is what authorises the sale
        const exit = await auth(request(app).post("/invest/exit"))
            .send({ id: "x1", sell: [{ asset: NVDA.address }] });
        expect(exit.status).toBe(200);
        expect(exit.body.selling).toHaveLength(1);
        expect(exit.body.selling[0].reason).toBe("owner_request");
        expect(exit.body.selling[0].symbol).toBe("NVDAc");
        expect(exit.body.selling[0].theme).toBe("ai-compute");

        // executing before the owner signs is refused exactly as it is for a buy
        expect((await auth(request(app).post("/invest/execute")).send({ id: "x1" })).status).toBe(409);

        const approved = await auth(request(app).post("/invest/approve"))
            .send({ id: "x1", signature: await signOffer(ownerAccount, exit.body.toSign) });
        expect(approved.status).toBe(200);

        const done = await auth(request(app).post("/invest/execute")).send({ id: "x1" });
        expect(done.status).toBe(200);
        expect(done.body.fills[0].side).toBe("sell");
        expect(done.body.fills[0].proceedsUsdc).toBeDefined();

        const after = await auth(request(app).get("/invest/holdings"));
        const sold = after.body.positions.find((p: { symbol: string }) => p.symbol === "NVDAc");
        expect(BigInt(sold.units)).toBe(0n);
        expect(sold.sells).toBe(1);

        const ledger = await auth(request(app).get("/invest/ledger"));
        expect(ledger.body.reconcile.ok).toBe(true);
        expect(ledger.body.balances[`positions.${NVDA.address.toLowerCase()}`] ?? "0").toBe("0");
    });

    it("trims a theme that has drifted past the mandate's band", async () => {
        // One theme in this harness, so the way to make it drift is to hold something under a theme the
        // mandate does not fund. ai-compute then sits at 100% against a renormalised target of 100%,
        // which is on target: the trim has to come from a second funded theme instead.
        const twoThemes: MandateTerms = {
            ...terms,
            themes: [{ id: "ai-compute", targetBps: 5000 }, { id: "platform-giants", targetBps: 5000 }],
            rebalanceBandBps: 500,
            minTradeUsdc: u("0.02"),
        };
        const store = new JsonlLedgerStore(join(dir, "drift.jsonl"));
        const engine = new InvestingEngine({
            mode: "sim",
            openingFloat: u("1.00"),
            mandates: mandateFor(twoThemes),
            readBrief: savedBrief,
            allBriefs: () => [savedBrief()],
            salesLedger: () => salesLedger("3.00"),
            market,
            chainId: CHAIN_ID,
            verifyApproval: ({ approval, signature }) =>
                verifyApprovalSignature({ approval, signature, chainId: CHAIN_ID, ownerAddress: ownerAccount.address }),
            ledger: await openLedger(store),
            sink: store,
        });
        await engine.syncRevenue();

        // Buy both tokens, one under each theme, deliberately lopsided.
        const legs: Leg[] = [
            { asset: NVDA.address.toLowerCase(), symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.60"), maxSlippageBps: 100 },
            { asset: MSFT.address.toLowerCase(), symbol: "MSFTc", theme: "platform-giants", usdcIn: u("0.20"), maxSlippageBps: 100 },
        ];
        const quotes = await market();
        const priced = await quotes.quote(legs);
        expect(engine.treasury.createProposal({ id: "p", legs, quotedPrices: priced.prices })).toEqual({ ok: true });
        engine.treasury.approve("p", "owner");
        expect(engine.treasury.execute("p", {
            freshPrices: priced.prices,
            decimals: new Map(quotes.trusted.map((t) => [t.address, t.decimals])),
        }).ok).toBe(true);

        // 75/25 against a 50/50 target: ai-compute is 2500 bps over a 500 bps band.
        const r = await engine.exit("x");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.candidates).toHaveLength(1);
        expect(r.candidates[0]!.reason).toBe("rebalance");
        expect(r.candidates[0]!.theme).toBe("ai-compute");
        // Solved for the weight after the sale: 0.60 of 0.80 is back to 50% once 0.40 has gone, since
        // the sale takes money out of the portfolio as well as out of the theme.
        expect(r.candidates[0]!.valueUsdc).toBe(u("0.40"));
        const ai = r.drift.themes.find((t) => t.theme === "ai-compute")!;
        expect(ai.actualBps).toBe(7500);
        expect(ai.targetBps).toBe(5000);
        expect(ai.overBand).toBe(true);
        // it trims rather than exits: two thirds of the holding's value goes, the rest stays
        expect(r.candidates[0]!.valueUsdc).toBeLessThan(u("0.60"));
        const holding = themeHoldings(engine.treasury.ledger.all())
            .find((h) => h.theme === "ai-compute" && h.asset === NVDA.address.toLowerCase())!;
        expect(r.candidates[0]!.units).toBeLessThan(holding.units);
    });

    it("refuses before quoting when no exit rule is set, so it reports no drift", async () => {
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const bought = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, bought.body.toSign) });
        await auth(request(app).post("/invest/execute")).send({ id: "p1" });

        const exit = await auth(request(app).post("/invest/exit")).send({ id: "x1" });
        expect(exit.status).toBe(409);
        // Nothing was quoted, so there is no reading to give. GET /invest/drift is where an owner
        // with no rule set goes to see the weights, which is the case that matters when choosing one.
        expect(exit.body.drift).toBeUndefined();
    });

    it("shows where the themes sit even though no exit rule is set", async () => {
        // The reading has to exist before the rule does, or an owner could never choose a band from
        // anything but a guess.
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const bought = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, bought.body.toSign) });
        await auth(request(app).post("/invest/execute")).send({ id: "p1" });

        const res = await auth(request(app).get("/invest/drift"));
        expect(res.status).toBe(200);
        expect(res.body.bandBps).toBeNull();
        expect(BigInt(res.body.totalUsdcMinor)).toBeGreaterThan(0n);
        const ai = res.body.themes.find((t: { theme: string }) => t.theme === "ai-compute");
        expect(ai.targetBps).toBe(10_000); // the only funded theme, so renormalised to the whole
        expect(ai.overBand).toBe(false);   // no band, so nothing can be over it
        expect(typeof res.body.asOf).toBe("string");
    });

    it("answers empty rather than erroring before the agent holds anything", async () => {
        const { app } = await build();
        const res = await auth(request(app).get("/invest/drift"));
        expect(res.status).toBe(200);
        expect(res.body.themes).toEqual([]);
        expect(res.body.totalUsdcMinor).toBe("0");
    });

    it("keeps the drift reading to the owner", async () => {
        const { app } = await build();
        expect((await request(app).get("/invest/drift")).status).toBe(401);
    });

    it("refuses to sell when the mandate states no exit and nothing was named", async () => {
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const bought = await auth(request(app).post("/invest/propose")).send({ id: "p1" });
        await auth(request(app).post("/invest/approve"))
            .send({ id: "p1", signature: await signOffer(ownerAccount, bought.body.toSign) });
        await auth(request(app).post("/invest/execute")).send({ id: "p1" });

        const exit = await auth(request(app).post("/invest/exit")).send({ id: "x1" });
        expect(exit.status).toBe(409);
        expect(exit.body.refused.join(" ")).toMatch(/states no exit rule/);
    });

    it("refuses to sell when the agent holds nothing", async () => {
        const { app } = await build();
        await auth(request(app).post("/invest/sync"));
        const exit = await auth(request(app).post("/invest/exit")).send({ id: "x1" });
        expect(exit.status).toBe(409);
        expect(exit.body.refused.join(" ")).toMatch(/holds nothing/);
    });

    it("refuses a malformed sale request rather than signing something it guessed at", async () => {
        const { app } = await build();
        for (const body of [
            { id: "x1", sell: "NVDAc" },
            { id: "x1", sell: [{ asset: "not-an-address" }] },
            { id: "x1", sell: [{ asset: NVDA.address, units: -5 }] },
            { id: "x1", sell: [{ asset: NVDA.address, units: "0" }] },
        ]) {
            const res = await auth(request(app).post("/invest/exit")).send(body);
            expect(res.status).toBe(400);
        }
    });

    it("needs the owner's token for the sell routes too", async () => {
        const { app } = await build();
        expect((await request(app).post("/invest/exit").send({ id: "x1" })).status).toBe(401);
        expect((await request(app).get("/invest/holdings")).status).toBe(401);
    });

    it("rejects a propose or approve with no id where one is required", async () => {
        const { app } = await build();
        expect((await auth(request(app).post("/invest/approve")).send({})).status).toBe(400);
        expect((await auth(request(app).post("/invest/execute")).send({})).status).toBe(400);
    });

    it("leaves the investing routes off when no engine is given, but keeps the mandate", async () => {
        // the mandate is the owner's constraint set, not an investing feature
        const { app } = buildServer({ config, mandates: mandateFor(terms), readBrief: savedBrief });
        expect((await auth(request(app).get("/invest/ledger"))).status).toBe(404);
        expect((await auth(request(app).post("/invest/propose")).send({ id: "p1" })).status).toBe(404);
        expect((await auth(request(app).get("/mandate"))).status).toBe(200);
    });
});

describe("per-brief attribution", () => {
    const briefNamed = (id: string, cost: string): SavedBrief => ({
        ...savedBrief(),
        file: `${id}.json`,
        costUsdcMinor: u(cost),
        brief: { ...savedBrief().brief, id },
    });

    /** A sales ledger with one payment per sale, each naming the brief it bought. */
    function salesFor(entries: { tx: string; amount: string; briefId?: string }[]): readonly LedgerTx[] {
        const l = new Ledger();
        entries.forEach((e, i) => {
            l.post({
                type: "PAYMENT_RECEIVED",
                mode: "testnet",
                at: new Date(Date.parse("2026-11-21T00:00:00Z") + i * 1000),
                idempotencyKey: `pay:x402:${e.tx}`,
                txHash: e.tx,
                ...(e.briefId !== undefined && { briefId: e.briefId }),
                lines: [
                    { account: "cash.operating", amount: u(e.amount) },
                    { account: "revenue.research", amount: -u(e.amount) },
                ],
            });
        });
        return l.all();
    }

    const engine = async (briefs: SavedBrief[], sales: readonly LedgerTx[], store?: JsonlLedgerStore) =>
        new InvestingEngine({
            mode: "sim",
            openingFloat: u("1.00"),
            mandates: mandateFor(terms),
            readBrief: () => briefs[briefs.length - 1]!,
            allBriefs: () => briefs,
            salesLedger: () => sales,
            market,
            chainId: CHAIN_ID,
            ...(store ? { ledger: await openLedger(store), sink: store } : {}),
        });

    it("books every brief's cost, not just the newest one", async () => {
        const briefs = [briefNamed("b1", "0.02"), briefNamed("b2", "0.03"), briefNamed("b3", "0.04")];
        const e = await engine(briefs, salesFor([{ tx: "0xa", amount: "3.00", briefId: "b1" }]));
        const r = await e.syncRevenue();
        expect(r.briefsCosted).toBe(3);
        expect(r.costs).toBe(u("0.09"));
        // the ledger agrees: total model spend is all three briefs, not only the one that sold
        expect(e.treasury.ledger.balance("expense.llm")).toBe(u("0.09"));
    });

    it("attributes each sale's revenue to the brief that was actually bought", async () => {
        const briefs = [briefNamed("b1", "0.02"), briefNamed("b2", "0.02")];
        const e = await engine(briefs, salesFor([
            { tx: "0xa", amount: "1.00", briefId: "b1" },
            { tx: "0xb", amount: "2.00", briefId: "b2" },
            { tx: "0xc", amount: "0.50", briefId: "b1" },
        ]));
        const r = await e.syncRevenue();
        expect(r.sales).toBe(3);
        expect(r.revenue).toBe(u("3.50"));
        expect(r.settled.map((x) => x.briefId)).toEqual(["b1", "b2"]);

        const paid = e.treasury.ledger.all().filter((x) => x.type === "PAYMENT_RECEIVED");
        expect(paid.map((x) => x.briefId)).toEqual(["b1", "b2", "b1"]);
        expect(paid.map((x) => x.txHash)).toEqual(["0xa", "0xb", "0xc"]);
    });

    it("counts each sale once, however often it syncs", async () => {
        const briefs = [briefNamed("b1", "0.02")];
        const sales = salesFor([{ tx: "0xa", amount: "1.00", briefId: "b1" }, { tx: "0xb", amount: "1.00", briefId: "b1" }]);
        const e = await engine(briefs, sales);
        await e.syncRevenue();
        const n = e.treasury.ledger.all().length;
        const again = await e.syncRevenue();
        expect(again.revenue).toBe(u("2.00"));
        expect(e.treasury.ledger.all().length).toBe(n);
        expect(e.treasury.ledger.balance("revenue.research")).toBe(-u("2.00"));
    });

    it("picks up a new sale after a restart without re-mirroring the old ones", async () => {
        const store = new JsonlLedgerStore(join(dir, "invest.jsonl"));
        const briefs = [briefNamed("b1", "0.02")];
        await (await engine(briefs, salesFor([{ tx: "0xa", amount: "1.00", briefId: "b1" }]), store)).syncRevenue();

        const after = await engine(briefs, salesFor([
            { tx: "0xa", amount: "1.00", briefId: "b1" },
            { tx: "0xb", amount: "1.00", briefId: "b1" },
        ]), store);
        await after.syncRevenue();
        expect(after.treasury.ledger.balance("revenue.research")).toBe(-u("2.00"));
        expect(after.treasury.ledger.all().filter((x) => x.type === "PAYMENT_RECEIVED").length).toBe(2);
    });

    it("keeps revenue for a sale that never named its brief, and says how many", async () => {
        const briefs = [briefNamed("b1", "0.02")];
        const e = await engine(briefs, salesFor([{ tx: "0xa", amount: "1.00" }]));
        const r = await e.syncRevenue();
        expect(r.unattributedSales).toBe(1);
        expect(r.revenue).toBe(u("1.00"));
        expect(e.treasury.ledger.all().find((x) => x.type === "PAYMENT_RECEIVED")!.briefId).toBe(UNATTRIBUTED);
    });

    it("refuses a book that lumped revenue before attribution existed, rather than guessing", async () => {
        const store = new JsonlLedgerStore(join(dir, "legacy.jsonl"));
        const legacy = new Ledger();
        legacy.post({
            type: "PAYMENT_RECEIVED", mode: "sim", at: new Date("2026-11-21T00:00:00Z"),
            idempotencyKey: "pay:mirror:20000", // the old lumped id, with no transaction to tie it to a sale
            lines: [
                { account: "cash.operating", amount: u("0.02") },
                { account: "revenue.research", amount: -u("0.02") },
            ],
        });
        store.append(legacy.all());
        await expect(engine([briefNamed("b1", "0.02")], salesFor([]), store))
            .rejects.toThrow(/lumped revenue entry/);
    });

    it("sends the reserve gap to the first settled brief and the rest to surplus", async () => {
        const briefs = [briefNamed("b1", "0.02"), briefNamed("b2", "0.02")];
        const e = await engine(briefs, salesFor([
            { tx: "0xa", amount: "1.00", briefId: "b1" },
            { tx: "0xb", amount: "1.00", briefId: "b2" },
        ]));
        const r = await e.syncRevenue();
        // reserve target is 0.50 in these terms, so b1 fills it and b2 is pure surplus
        expect(e.treasury.ledger.balance("reserve")).toBe(u("0.50"));
        expect(r.settled[0]!.investable).toBeLessThan(r.settled[1]!.investable);
        expect(reconcileInternal(e.treasury.ledger).ok).toBe(true);
    });
});

describe("H1 regression: later sales keep reaching the surplus", () => {
    it("sweeps a second sale of the same brief instead of parking it in cash", async () => {
        const briefs = [{ ...savedBrief(), costUsdcMinor: u("0.02") }];
        const one = [{ tx: "0xa", amount: "1.00", briefId: "brief-test" }];
        const two = [...one, { tx: "0xb", amount: "5.00", briefId: "brief-test" }];
        let current = one;

        const mk = (list: typeof one) => list.map((e, i) => ({ ...e, i }));
        void mk;
        const ledgerFor = (list: typeof one) => {
            const l = new Ledger();
            list.forEach((e, i) => l.post({
                type: "PAYMENT_RECEIVED", mode: "testnet",
                at: new Date(Date.parse("2026-11-21T00:00:00Z") + i * 1000),
                idempotencyKey: `pay:x402:${e.tx}`, txHash: e.tx, briefId: e.briefId,
                lines: [
                    { account: "cash.operating", amount: u(e.amount) },
                    { account: "revenue.research", amount: -u(e.amount) },
                ],
            }));
            return l.all();
        };

        const e = new InvestingEngine({
            mode: "sim", openingFloat: u("1.00"), mandates: mandateFor(terms),
            readBrief: () => briefs[0]!, allBriefs: () => briefs,
            salesLedger: () => ledgerFor(current), market, chainId: CHAIN_ID,
        });

        await e.syncRevenue();
        const afterFirst = e.treasury.ledger.balance("surplus.investable");
        expect(afterFirst).toBeGreaterThan(0n);

        current = two;
        const r = await e.syncRevenue();
        expect(r.revenue).toBe(u("6.00"));
        // the 5.00 second sale must reach the surplus, not sit in operating cash
        expect(e.treasury.ledger.balance("surplus.investable")).toBe(afterFirst + u("2.50"));
        expect(reconcileInternal(e.treasury.ledger).ok).toBe(true);
    });
});

describe("H2 regression: a signature cannot cross a mandate change", () => {
    const withMandates = (mandates: MandateStore) => new InvestingEngine({
        mode: "sim", openingFloat: u("1.00"), mandates,
        readBrief: savedBrief, allBriefs: () => [savedBrief()],
        salesLedger: () => salesLedger("3.00"), market, chainId: CHAIN_ID,
        verifyApproval: ({ approval, signature }) =>
            verifyApprovalSignature({ approval, signature, chainId: CHAIN_ID, ownerAddress: ownerAccount.address }),
    });

    it("refuses an approval signed under the previous mandate version", async () => {
        const mandates = new MandateStore();
        mandates.create(terms);
        const e = withMandates(mandates);
        await e.syncRevenue();

        const p = await e.propose("p1");
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        const signature = await signOffer(ownerAccount, p.toSign);

        // the owner changes a term the policy engine does not inspect, so nothing else would catch it
        mandates.create({ ...terms, driftToleranceBps: 1 });

        const a = await e.approve("p1", signature);
        expect(a.ok).toBe(false);
        if (!a.ok) expect(a.reasons.join(" ")).toMatch(/mandate changed since this was offered/);
        // and the proposal must not be executable
        await expect(e.execute("p1")).rejects.toThrow(/expected APPROVED/);
    });

    it("still accepts a signature when the mandate has not moved", async () => {
        const mandates = new MandateStore();
        mandates.create(terms);
        const e = withMandates(mandates);
        await e.syncRevenue();
        const p = await e.propose("p1");
        if (!p.ok) return;
        const a = await e.approve("p1", await signOffer(ownerAccount, p.toSign));
        expect(a.ok).toBe(true);
    });
});

describe("H3/H4 regression: buyer briefs do not disturb the owner's loop", () => {
    const briefWithThemes = (id: string, themeIds: string[]): SavedBrief => ({
        ...savedBrief(),
        brief: {
            ...savedBrief().brief,
            id,
            themes: themeIds.map((t) => ({
                themeId: t,
                gap: false,
                claims: [{ id: `${t}:c1`, type: "fact" as const, text: "x", sourceIds: ["s1"],
                    quotes: [{ sourceId: "s1", text: "data center revenue grew" }] }],
                fits: [{ asset: NVDA.address, symbol: "NVDAc", fit: 5, evidence: 2, claimIds: [`${t}:c1`] }],
            })),
        },
    });

    const engineForBrief = (b: SavedBrief) => new InvestingEngine({
        mode: "sim", openingFloat: u("1.00"), mandates: mandateFor(terms),
        readBrief: () => b, allBriefs: () => [b],
        salesLedger: () => salesLedger("3.00"), market, chainId: CHAIN_ID,
    });

    it("skips a theme the mandate does not fund instead of throwing", async () => {
        const e = engineForBrief(briefWithThemes("mixed", ["ai-compute", "a-buyers-own-theme"]));
        await e.syncRevenue();
        const p = await e.propose("p1");
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.view.legs.length).toBeGreaterThan(0);
        expect(p.view.legs.every((l) => l.theme === "ai-compute")).toBe(true);
        expect(p.warnings.join(" ")).toMatch(/a-buyers-own-theme.*not funded/);
    });

    it("refuses clearly when nothing in the brief is funded, rather than crashing", async () => {
        const e = engineForBrief(briefWithThemes("custom", ["a-buyers-own-theme"]));
        await e.syncRevenue();
        const p = await e.propose("p1");
        expect(p.ok).toBe(false);
        if (!p.ok) expect(p.reasons.join(" ")).toMatch(/no theme the mandate funds.*a-buyers-own-theme/);
    });
});

describe("M2 regression: working capital is a total, not a per-amount entry", () => {
    const withFloat = async (store: JsonlLedgerStore, float: bigint) => new InvestingEngine({
        mode: "sim", openingFloat: float, mandates: mandateFor(terms),
        readBrief: savedBrief, allBriefs: () => [savedBrief()],
        salesLedger: () => salesLedger("3.00"), market, chainId: CHAIN_ID, ledger: await openLedger(store), sink: store,
    });

    it("books only the increase when the owner raises the float", async () => {
        const store = new JsonlLedgerStore(join(dir, "float.jsonl"));
        await withFloat(store, u("1.00"));
        const second = await withFloat(store, u("2.00"));
        expect(second.treasury.ledger.balance("equity.opening")).toBe(-u("2.00"));
        expect(second.treasury.ledger.balance("cash.operating")).toBe(u("2.00"));
        expect(second.treasury.ledger.all().filter((x) => x.type === "OPENING_BALANCE").length).toBe(2);
    });

    it("books nothing when the float is unchanged", async () => {
        const store = new JsonlLedgerStore(join(dir, "same.jsonl"));
        await withFloat(store, u("1.00"));
        const second = await withFloat(store, u("1.00"));
        expect(second.treasury.ledger.all().filter((x) => x.type === "OPENING_BALANCE").length).toBe(1);
        expect(second.treasury.ledger.balance("equity.opening")).toBe(-u("1.00"));
    });

    it("refuses a reduction rather than rewriting history", async () => {
        const store = new JsonlLedgerStore(join(dir, "down.jsonl"));
        await withFloat(store, u("2.00"));
        await expect(withFloat(store, u("1.00"))).rejects.toThrow(/already booked/);
    });
});

describe("the mandate can forbid investing while behind", () => {
    /**
     * The real shape of the problem: one brief sold well and produced surplus, while other briefs cost
     * money and never sold. A single brief cannot be both profitable and leave the agent behind.
     */
    const engineWith = (mandates: MandateStore, revenue: string, unsoldCost: bigint) => {
        const sold: SavedBrief = { ...savedBrief(), costUsdcMinor: u("0.10") };
        const unsold: SavedBrief = {
            ...savedBrief(),
            file: "unsold.json",
            costUsdcMinor: unsoldCost,
            brief: { ...savedBrief().brief, id: "brief-unsold" },
        };
        return new InvestingEngine({
            mode: "sim", openingFloat: u("20.00"), mandates,
            readBrief: () => sold, allBriefs: () => [sold, unsold],
            salesLedger: () => salesLedger(revenue), market, chainId: CHAIN_ID,
        });
    };

    it("refuses to propose while lifetime costs exceed lifetime revenue", async () => {
        const mandates = new MandateStore();
        mandates.create({ ...terms, reserveTargetUsdc: u("0"), investOnlyWhenAhead: true });
        // the sold brief earns 5.00 against its 0.10 cost, so there is surplus to invest,
        // but an unsold brief cost 6.00, leaving the agent 1.10 behind over its life
        const e = engineWith(mandates, "5.00", u("6.00"));
        await e.syncRevenue();
        expect(e.treasury.ledger.balance("surplus.investable")).toBeGreaterThan(0n);
        expect(e.lifetime().behindBy).toBe(u("1.10"));

        const r = await e.propose("p1");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reasons.join(" ")).toMatch(/forbids investing while behind.*behind by 1\.100000/);
    });

    it("proposes once the agent is ahead again", async () => {
        const mandates = new MandateStore();
        mandates.create({ ...terms, reserveTargetUsdc: u("0"), investOnlyWhenAhead: true });
        const e = engineWith(mandates, "5.00", u("1.00"));
        await e.syncRevenue();
        expect(e.lifetime().behindBy).toBe(0n);
        const r = await e.propose("p1");
        expect(r.ok).toBe(true);
    });

    it("leaves a mandate without the term behaving as before", async () => {
        const mandates = new MandateStore();
        mandates.create({ ...terms, reserveTargetUsdc: u("0") }); // term absent
        const e = engineWith(mandates, "5.00", u("6.00"));
        await e.syncRevenue();
        expect(e.lifetime().behindBy).toBeGreaterThan(0n);
        const r = await e.propose("p1");
        expect(r.ok).toBe(true); // behind, but nothing in this mandate forbids it
    });

    it("reports the lifetime position from its own book", async () => {
        const mandates = new MandateStore();
        mandates.create({ ...terms, reserveTargetUsdc: u("0") });
        const e = engineWith(mandates, "5.00", u("6.00"));
        await e.syncRevenue();
        const l = e.lifetime();
        expect(l.revenue).toBe(u("5.00"));
        expect(l.costs).toBe(u("6.10")); // 0.10 for the sold brief, 6.00 for the unsold one
        expect(l.behindBy).toBe(u("1.10"));
    });
});

describe("money earned on one network cannot fund another", () => {
    it("refuses to mirror testnet revenue into a mainnet book", async () => {
        // Selling runs on Sepolia because that is the only network the free facilitator serves, and the
        // stocks exist only on Base mainnet. Mirroring across would have the agent spend real money
        // while its books claimed it had earned it.
        const e = new InvestingEngine({
            mode: "mainnet",
            openingFloat: u("5.00"),
            mandates: mandateFor(terms),
            readBrief: savedBrief,
            allBriefs: () => [savedBrief()],
            salesLedger: () => salesLedger("3.00"), // tagged testnet
            market,
            chainId: CHAIN_ID,
        });

        const r = await e.syncRevenue();
        expect(r.sales).toBe(0);
        expect(r.revenue).toBe(0n);
        expect(r.refusedSales.length).toBe(1);
        expect(r.refusedSales[0]!.mode).toBe("testnet");
        expect(e.treasury.ledger.balance("revenue.research")).toBe(0n);

        // what a mainnet book may invest is the owner's capital, and it is labelled as that
        const opening = e.treasury.ledger.all().find((x) => x.type === "OPENING_BALANCE");
        expect(opening?.memo?.toLowerCase()).toContain("owner");
    });

    it("mirrors normally when both books are on the same network", async () => {
        const e = await engineFor("3.00"); // sim book, sim sales
        const r = await e.syncRevenue();
        expect(r.sales).toBe(1);
        expect(r.refusedSales).toEqual([]);
    });
});

describe("executing for real", () => {
    /** An executor that records what it was asked to send, and can fail on a chosen symbol. */
    function fakeExecutor(over: { failOn?: string; amountOut?: bigint } = {}) {
        const sent: { key: string; symbol: string; usdcIn: bigint }[] = [];
        return {
            sent,
            executor: {
                fill: async (order: { symbol: string; usdcIn: bigint }, _quote: unknown, key: string) => {
                    sent.push({ key, symbol: order.symbol, usdcIn: order.usdcIn });
                    if (order.symbol === over.failOn) throw new Error("swap reverted on chain");
                    return {
                        amountOut: over.amountOut ?? 7_000_000_000_000_000n,
                        transaction: "0x" + "ab".repeat(32),
                    };
                },
            },
        };
    }

    const mainnetEngine = async (executor?: { fill: unknown }, clock?: () => Date) =>
        new InvestingEngine({
            mode: "mainnet",
            openingFloat: u("1.00"),
            mandates: mandateFor(terms),
            readBrief: savedBrief,
            allBriefs: () => [savedBrief()],
            // a mainnet book may only mirror mainnet revenue; see the guard above
            salesLedger: () => salesLedger("3.00", "mainnet"),
            market,
            chainId: CHAIN_ID,
            verifyApproval: ({ approval, signature }) =>
                verifyApprovalSignature({ approval, signature, chainId: CHAIN_ID, ownerAddress: ownerAccount.address }),
            ...(executor !== undefined && { executor: executor as never }),
            ...(clock !== undefined && { now: clock }),
        });

    const approved = async (e: InvestingEngine) => {
        await e.syncRevenue();
        const p = await e.propose("p1");
        if (!p.ok) throw new Error(`the proposal was refused: ${p.reasons.join("; ")}`);
        const r = await e.approve("p1", await signOffer(ownerAccount, p.toSign));
        if (!r.ok) throw new Error(`the approval was refused: ${JSON.stringify(r)}`);
    };

    it("sends a swap per order and books the quantity that came back", async () => {
        const fake = fakeExecutor({ amountOut: 9_000_000_000_000_000n });
        const e = await mainnetEngine(fake.executor);
        await approved(e);

        const result = await e.execute("p1");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.simulated).toBe(false);
        expect(fake.sent.length).toBeGreaterThan(0);
        // keyed by proposal and position, so a retry resumes rather than sends again
        expect(fake.sent[0]!.key).toMatch(/^p1:\d+$/);

        // the booked quantity is what the chain returned, split across the legs that paid
        const booked = result.fills.reduce((a, f) => a + BigInt(f.quantity), 0n);
        expect(booked).toBe(9_000_000_000_000_000n * BigInt(fake.sent.length));
        expect(result.unfilled).toEqual([]);

        const entry = e.treasury.ledger.all().find((x) => x.type === "PURCHASE_SETTLED");
        expect(entry?.txHash).toBe("0x" + "ab".repeat(32));
        expect(entry?.memo).not.toContain("SIMULATED");
    });

    it("books only what executed when a swap fails, and does not settle the proposal", async () => {
        const fake = fakeExecutor({ failOn: "NVDAc" });
        const e = await mainnetEngine(fake.executor);
        await approved(e);

        const result = await e.execute("p1");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.warnings.join(" ")).toMatch(/swap reverted on chain/);
        // nothing was booked for the leg whose swap failed
        expect(result.fills.every((f) => f.symbol !== "NVDAc")).toBe(true);
        expect(result.unfilled.some((x) => x.symbol === "NVDAc")).toBe(true);
        expect(e.treasury.state("p1")).toBe("FAILED");
    });

    it("sends nothing for a proposal the owner never signed", async () => {
        // The swaps go out before the treasury books them, so its refusal alone would come too late.
        const fake = fakeExecutor();
        const e = await mainnetEngine(fake.executor);
        await e.syncRevenue();
        await e.propose("p1");
        await expect(e.execute("p1")).rejects.toThrow(/expected APPROVED/);
        expect(fake.sent).toEqual([]);
    });

    it("sends nothing once the approval has expired", async () => {
        const fake = fakeExecutor();
        let at = new Date();
        const e = await mainnetEngine(fake.executor, () => at);
        await approved(e);
        at = new Date(at.getTime() + 3_600_000);
        const result = await e.execute("p1");
        expect(result.ok).toBe(false);
        expect(fake.sent).toEqual([]);
    });

    it("sends nothing at all without an executor, and says the fills are simulated", async () => {
        const e = await mainnetEngine();
        await approved(e);
        const result = await e.execute("p1");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.simulated).toBe(true);
        expect(result.fills.length).toBeGreaterThan(0);
        expect(e.treasury.ledger.all().find((x) => x.type === "PURCHASE_SETTLED")?.memo)
            .toContain("SIMULATED");
    });
});

describe("a proposal served by a different process at each step", () => {
    /** A fresh engine over the same storage, which is what every request gets on a serverless host. */
    const instance = async (books: JsonlLedgerStore, proposals: ProposalStore) =>
        new InvestingEngine({
            mode: "sim",
            openingFloat: u("1.00"),
            mandates: mandateFor(terms),
            readBrief: savedBrief,
            allBriefs: () => [savedBrief()],
            salesLedger: () => salesLedger("3.00"),
            market,
            chainId: CHAIN_ID,
            verifyApproval: ({ approval, signature }) =>
                verifyApprovalSignature({ approval, signature, chainId: CHAIN_ID, ownerAddress: ownerAccount.address }),
            ledger: await openLedger(books),
            sink: books,
            proposals,
        });

    const offered = async () => {
        const books = new JsonlLedgerStore(join(dir, "invest.jsonl"));
        const proposals = new MemoryProposalStore();
        const first = await instance(books, proposals);
        await first.syncRevenue();
        const p = await first.propose("p1");
        if (!p.ok) throw new Error(p.reasons.join("; "));
        return { books, proposals, p };
    };

    it("is approved and executed after the process that offered it has gone", async () => {
        const { books, proposals, p } = await offered();

        const second = await instance(books, proposals);
        const a = await second.approve("p1", await signOffer(ownerAccount, p.toSign));
        expect(a.ok).toBe(true);

        const third = await instance(books, proposals);
        const x = await third.execute("p1");
        expect(x.ok).toBe(true);
        expect(third.treasury.state("p1")).toBe("SETTLED");
        expect(reconcileInternal(third.treasury.ledger).ok).toBe(true);
    });

    it("keeps the hash the owner signed, bigint for bigint", async () => {
        const { books, proposals, p } = await offered();
        const second = await instance(books, proposals);
        await second.approve("p1", await signOffer(ownerAccount, p.toSign));
        expect(second.view("p1").hash).toBe(p.view.hash);
    });

    it("is not executed a second time by an instance that has not seen the first", async () => {
        const { books, proposals, p } = await offered();
        const second = await instance(books, proposals);
        await second.approve("p1", await signOffer(ownerAccount, p.toSign));
        const stale = await instance(books, proposals);
        await second.execute("p1");
        await expect(stale.execute("p1")).rejects.toThrow(/is SETTLED/);
    });

    it("still refuses an unsigned proposal after the move", async () => {
        const { books, proposals } = await offered();
        const second = await instance(books, proposals);
        await expect(second.execute("p1")).rejects.toThrow(/expected APPROVED/);
    });

    it("will not reuse an id another instance has taken", async () => {
        const { books, proposals } = await offered();
        const second = await instance(books, proposals);
        await expect(second.propose("p1")).rejects.toThrow(/already exists/);
    });
});
