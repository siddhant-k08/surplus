import { AsyncLocalStorage } from "node:async_hooks";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
    Treasury,
    flushNewEntries,
    realizedSales,
    reconcileInternal,
    scanBriefs,
    loadLatestBrief,
    formatUsdc,
    type Ledger,
    type LedgerSink,
    type LedgerTx,
    type MandateStore,
    type MandateTerms,
    type MandateVersion,
    type SavedBrief,
} from "@surplus/core";
import type { ApiConfig } from "./config";
import {
    SessionStore, requireOwnerAccess, verifyLogin, loginPayload,
    SESSION_COOKIE, SESSION_TTL_MS, readCookie,
} from "./session";
import { UNATTRIBUTED, type InvestingEngine } from "./investing";
import { normalizeThemes, type ResearchService } from "./research";
import { parseTermsUpdate, changedTerms } from "./terms";
import { JsonlReceiptStore, newReceiptId } from "./receipts";

export const BRIEF_ROUTE = "/brief";

/**
 * Which brief the handler actually served, readable by the settlement hook.
 *
 * The hook runs after the handler in the same request, but it is not given the response, so it used to ask
 * for "the newest brief" instead. That is wrong whenever the handler served something else: a cached
 * custom brief, or any brief at all once a concurrent request has written a newer one. Revenue would then
 * be attributed to a brief the buyer never bought.
 */
interface ServedContext {
    briefId?: string;
    /** Where the served brief lives, so a receipt can find it again. */
    source?: "catalogue" | "custom";
    /**
     * The receipt secret handed to the buyer in this response.
     *
     * Minted in the handler because settlement happens after the handler returns, so the response has to
     * carry it before the transaction exists. The hook binds the two once the payment settles; if it
     * never settles, the id was never stored and looking it up simply finds nothing.
     */
    receiptId?: string;
}
const servedStore = new AsyncLocalStorage<ServedContext>();

/** Records the brief this request served, so settlement can attribute the sale to it. */
export function noteServedBrief(briefId: string, source: "catalogue" | "custom" = "catalogue"): string {
    const ctx = servedStore.getStore();
    const receiptId = newReceiptId();
    if (ctx !== undefined) {
        ctx.briefId = briefId;
        ctx.source = source;
        ctx.receiptId = receiptId;
    }
    return receiptId;
}
export const RESEARCH_ROUTE = "/research";

export interface BookedSale {
    transaction: string;
    payer: string | undefined;
    amountUsdcMinor: bigint;
    briefId: string;
    at: string;
}

/** Why a settlement did or did not become ledger revenue. */
export type BookingVerdict = "booked" | "not_settled" | "wrong_asset" | "zero_amount";

export interface SettlementFacts {
    success: boolean;
    transaction: string;
    payer?: string | undefined;
    /** Actual settled amount in atomic units, when the scheme reports one. */
    amount?: string | undefined;
    /** The amount that was required, also in atomic units. */
    requiredAmount: string;
    asset: string;
}

/**
 * Turns a settled payment into ledger revenue, or explains why it did not.
 *
 * Kept separate from the hook so the money rules can be tested without a real payment. The amount is booked
 * as USDC minor units only when the asset is the expected USDC, because atomic units of some other token
 * would be a different quantity entirely. The ledger key is the settlement transaction, so a replayed
 * settlement is idempotent rather than double counted.
 */
export function bookSettlement(args: {
    treasury: Treasury;
    sales: BookedSale[];
    expectedAsset: string;
    briefId: string;
    facts: SettlementFacts;
    at?: Date;
}): BookingVerdict {
    const { treasury, sales, expectedAsset, briefId, facts } = args;
    if (!facts.success) return "not_settled";
    if (facts.asset.toLowerCase() !== expectedAsset.toLowerCase()) return "wrong_asset";

    const amount = BigInt(facts.amount ?? facts.requiredAmount);
    if (amount <= 0n) return "zero_amount";

    treasury.receivePayment({
        id: `x402:${facts.transaction}`,
        briefId,
        amount,
        txHash: facts.transaction,
        memo: briefId, // provenance: a persisted entry should say which brief was sold
    });
    if (!sales.some((s) => s.transaction === facts.transaction)) {
        sales.push({
            transaction: facts.transaction,
            payer: facts.payer,
            amountUsdcMinor: amount,
            briefId,
            at: (args.at ?? new Date()).toISOString(),
        });
    }
    return "booked";
}

export interface ServerDeps {
    config: ApiConfig;
    /** The owner's mandate. Shared with the investing engine so both see the same version. */
    mandates: MandateStore;
    /** Overridable so tests can run without the docs/briefs directory. */
    readBrief?: () => SavedBrief;
    /** Already loaded, because storage is async and `buildServer` is not. */
    ledger?: Ledger;
    /** Where new entries go. Absent means nothing is persisted. */
    sink?: LedgerSink;
    /** When given, the owner-gated investing routes are mounted. */
    engine?: InvestingEngine;
    /** When given, the paid on-demand research route is mounted. */
    research?: ResearchService;
    /** Shared so tests can drive sign-in; one is made per server otherwise. */
    sessions?: SessionStore;
    /** When given, a paid request returns a receipt the buyer can come back to. */
    receipts?: JsonlReceiptStore;
    /**
     * Finds a brief by id for a receipt lookup.
     *
     * A receipt can name any brief ever sold, not just the newest, so this scans rather than reusing
     * `readBrief`. Injectable because the directories are the server's business, not a test's.
     */
    findBrief?: (briefId: string, source: "catalogue" | "custom") => SavedBrief | null;
    /**
     * Creates and persists a new mandate version from the owner's terms.
     *
     * Passed in rather than done here so the server never holds the means to change a user constraint on
     * its own: without this the update route refuses.
     */
    updateMandate?: (terms: MandateTerms) => MandateVersion;
}

/**
 * Rebuilds the sales list from ledger entries rather than storing it twice.
 *
 * Delegates to core's `realizedSales`, which is the single answer to what the agent actually earned, so
 * this endpoint and the investing loop cannot disagree about it. The payer is not kept in the ledger; it
 * lives in the settlement record, so a restored sale has none.
 */
export function salesFromLedger(entries: readonly LedgerTx[]): BookedSale[] {
    return realizedSales(entries).map((s) => ({
        transaction: s.transaction,
        payer: undefined,
        amountUsdcMinor: s.amountUsdcMinor,
        briefId: s.briefId ?? "unknown", // older entries predate the structured field
        at: s.at,
    }));
}

/** Mandate version as JSON, with every limit as a decimal string of minor units. */
export function mandateView(m: MandateVersion) {
    return {
        version: m.version,
        hash: m.hash,
        prevHash: m.prevHash,
        createdAt: m.createdAt,
        terms: {
            eligible: m.terms.eligible,
            themes: m.terms.themes,
            maxCompanyBps: m.terms.maxCompanyBps,
            investShareBps: m.terms.investShareBps,
            maxSlippageBps: m.terms.maxSlippageBps,
            driftToleranceBps: m.terms.driftToleranceBps,
            approvalExpirySeconds: m.terms.approvalExpirySeconds,
            maxTradeUsdc: m.terms.maxTradeUsdc.toString(),
            minTradeUsdc: m.terms.minTradeUsdc.toString(),
            reserveTargetUsdc: m.terms.reserveTargetUsdc.toString(),
        },
    };
}

export interface BuiltServer {
    app: Express;
    sessions: SessionStore;
    treasury: Treasury;
    sales: BookedSale[];
}

/**
 * Builds the paid research endpoint.
 *
 * Money is booked in an `onAfterSettle` hook, not in the route handler, so revenue is recorded only once the
 * facilitator reports a settled payment. The ledger entry is idempotent on the settlement transaction, so a
 * retried or replayed request cannot book the same sale twice.
 *
 * The brief itself is served by the handler. Research output is informational and is not investment advice;
 * every claim carries the quote it came from so a reader can check it.
 */
export function buildServer(deps: ServerDeps): BuiltServer {
    const { config, mandates } = deps;
    const readBrief = deps.readBrief ?? ((): SavedBrief => loadLatestBrief(config.briefsDir));
    const findBrief = deps.findBrief ?? ((briefId: string, source: "catalogue" | "custom"): SavedBrief | null => {
        const dir = source === "custom" ? config.customBriefsDir : config.briefsDir;
        return scanBriefs(dir).briefs.find((b) => b.brief.id === briefId) ?? null;
    });

    // Replaying the stored entries restores the balances and, importantly, the dedup index: a settlement
    // that arrives again after a restart is refused by the ledger rather than booked a second time.
    const ledger = deps.ledger;
    const treasury = new Treasury({ mode: config.mode, mandates, ...(ledger && { ledger }) });
    const sales: BookedSale[] = ledger ? salesFromLedger(ledger.all()) : [];
    let persistedId = ledger ? (ledger.all().at(-1)?.id ?? 0) : 0;

    const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitator)
        .register(config.network, new ExactEvmScheme())
        .onAfterSettle(async (ctx) => {
            const { result, requirements } = ctx;
            const verdict = bookSettlement({
                treasury,
                sales,
                expectedAsset: config.expectedAsset,
                // never fall back to "the newest brief": attributing a sale to the wrong brief is worse
                // than recording that it is unknown, which `syncRevenue` reports as unattributed
                briefId: servedStore.getStore()?.briefId ?? UNATTRIBUTED,
                facts: {
                    success: result.success,
                    transaction: result.transaction,
                    payer: result.payer,
                    amount: result.amount,
                    requiredAmount: requirements.amount,
                    asset: requirements.asset,
                },
            });
            if (verdict === "wrong_asset") {
                console.warn(
                    `settled payment in unexpected asset ${requirements.asset}, expected ${config.expectedAsset}; no revenue booked`,
                );
            } else if (verdict === "booked") {
                const amount = BigInt(result.amount ?? requirements.amount);
                const served = servedStore.getStore();
                if (deps.receipts !== undefined && served?.receiptId !== undefined && served.briefId !== undefined) {
                    deps.receipts.issue({
                        id: served.receiptId,
                        briefId: served.briefId,
                        source: served.source ?? "catalogue",
                        transaction: result.transaction,
                        amountUsdcMinor: amount.toString(),
                        at: new Date().toISOString(),
                    });
                }
                if (deps.sink !== undefined) {
                    // flushed before this hook returns, so the settlement is durable before the SDK is
                    // told the payment is done; a crash in between would leave money received unrecorded
                    persistedId = await flushNewEntries(treasury.ledger, deps.sink, persistedId);
                }
                console.log(`booked ${formatUsdc(amount)} USDC (tx ${result.transaction})`);
            }
        });

    const app = express();
    app.disable("x-powered-by");
    app.use((_req, _res, next) => servedStore.run({}, next));
    // a small cap: these bodies carry an id, never a document
    app.use(express.json({ limit: "16kb" }));

    const sessions = deps.sessions ?? new SessionStore();
    const owner = requireOwnerAccess({ token: config.ownerToken, sessions });

    // ---- sign in with the owner wallet ----
    //
    // The nonce is single use and expires, the signature is EIP-712 bound to the chain, and the
    // recovered address must equal the configured owner. The session rides in an httpOnly,
    // SameSite=Strict cookie so another origin cannot use it, and it never contains the owner token.
    app.post("/auth/nonce", (_req: Request, res: Response) => {
        const { nonce, issuedAt } = sessions.issueNonce();
        const payload = loginPayload({
            address: config.ownerAddress, nonce, issuedAt, chainId: config.approvalChainId,
        });
        // issuedAt is a uint256 in the typed data, so it crosses the wire as a decimal string
        res.json({
            ...payload,
            message: { ...payload.message, issuedAt: payload.message.issuedAt.toString() },
        });
    });

    app.post("/auth/verify", async (req: Request, res: Response) => {
        const body = req.body as { signature?: unknown; nonce?: unknown } | undefined;
        if (typeof body?.signature !== "string" || typeof body.nonce !== "string") {
            return void res.status(400).json({ error: "signature and nonce are required" });
        }
        const issuedAt = sessions.consumeNonce(body.nonce);
        if (issuedAt === null) {
            return void res.status(400).json({ error: "that sign-in request expired or was already used" });
        }
        const verdict = await verifyLogin({
            signature: body.signature,
            nonce: body.nonce,
            issuedAt,
            chainId: config.approvalChainId,
            ownerAddress: config.ownerAddress,
        });
        if (!verdict.ok) return void res.status(401).json({ error: verdict.reason });

        const { token, expiresAt } = sessions.open(verdict.address);
        res.cookie(SESSION_COOKIE, token, {
            httpOnly: true,
            sameSite: "strict",
            secure: config.cookieSecure,
            maxAge: SESSION_TTL_MS,
            path: "/",
        });
        res.json({ address: verdict.address, expiresAt });
    });

    app.post("/auth/logout", (req: Request, res: Response) => {
        const cookie = readCookie(req.header("cookie"), SESSION_COOKIE);
        if (cookie !== null) sessions.close(cookie);
        res.clearCookie(SESSION_COOKIE, { path: "/" });
        res.json({ signedOut: true });
    });

    app.get("/auth/me", (req: Request, res: Response) => {
        const cookie = readCookie(req.header("cookie"), SESSION_COOKIE);
        const address = cookie === null ? null : sessions.whoIs(cookie);
        res.json({ signedIn: address !== null, address });
    });

    app.use(
        paymentMiddleware(
            {
                [`GET ${BRIEF_ROUTE}`]: {
                    accepts: [
                        {
                            scheme: "exact",
                            price: config.priceUsd,
                            network: config.network,
                            payTo: config.payTo,
                        },
                    ],
                    description: "Cited, multi-theme tokenized-stock research brief. Informational only, not investment advice.",
                    mimeType: "application/json",
                },
                ...(deps.research === undefined ? {} : {
                    [`POST ${RESEARCH_ROUTE}`]: {
                        accepts: [
                            {
                                scheme: "exact",
                                price: config.researchPriceUsd,
                                network: config.network,
                                payTo: config.payTo,
                            },
                        ],
                        description: "A brief generated for the themes you send. Informational only, not investment advice.",
                        mimeType: "application/json",
                    },
                }),
            },
            resourceServer,
        ),
    );

    // free: enough to see what the endpoint sells and on which network, without paying
    app.get("/health", (_req: Request, res: Response) => {
        let briefId: string | null = null;
        let createdAt: string | null = null;
        try {
            const saved = readBrief();
            briefId = saved.brief.id;
            createdAt = saved.brief.createdAt;
        } catch {
            briefId = null;
        }
        res.json({
            ok: true,
            mode: config.mode,
            network: config.network,
            facilitator: config.facilitatorUrl,
            payTo: config.payTo,
            price: config.priceUsd,
            asset: config.expectedAsset,
            route: BRIEF_ROUTE,
            ledgerPublic: config.publicLedger,
            latestBrief: briefId,
            latestBriefCreatedAt: createdAt,
            salesBooked: sales.length,
        });
    });

    app.get(BRIEF_ROUTE, (_req: Request, res: Response) => {
        const saved = readBrief();
        const receiptId = noteServedBrief(saved.brief.id, "catalogue");
        res.json({
            brief: saved.brief,
            provider: saved.provider,
            model: saved.model,
            disclaimer: saved.brief.disclaimer,
            receipt: { id: receiptId, url: `/r/${receiptId}` },
        });
    });

    // Paid, on demand: a brief for the buyer's own themes.
    //
    // The scheme's flow is `authorization`: the payment is verified before this handler runs and settled
    // after it returns, and a handler that throws cancels the verified payment (`handler_threw`). So a
    // failed generation must propagate rather than be swallowed: the buyer is then not charged for a brief
    // they never received. Invalid themes are refused the same way, before any model call is made.
    if (deps.research !== undefined) {
        const research = deps.research;
        app.post(RESEARCH_ROUTE, async (req: Request, res: Response, next: NextFunction) => {
            const parsed = normalizeThemes((req.body as { themes?: unknown } | undefined)?.themes);
            if (!parsed.ok) {
                res.status(400).json({ error: "themes were not accepted", details: parsed.errors });
                return;
            }
            try {
                const outcome = await research.obtain(parsed.themes);
                const receiptId = noteServedBrief(outcome.saved.brief.id, "custom");
                res.json({
                    receipt: { id: receiptId, url: `/r/${receiptId}` },
                    brief: outcome.saved.brief,
                    provider: outcome.saved.provider,
                    model: outcome.saved.model,
                    cached: outcome.cached,
                    disclaimer: outcome.saved.brief.disclaimer,
                    generation: {
                        costUsdcMinor: outcome.costUsdcMinor.toString(),
                        validationIssues: outcome.issues,
                        droppedByVerification: outcome.rejected,
                    },
                });
            } catch (e) {
                // let the SDK cancel the verified payment rather than charging for nothing
                next(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    // The chronological sales book. Public only when the operator opts in with PUBLIC_LEDGER=true;
    // otherwise it needs the owner token, because it is the operator's whole financial history.
    const ledgerGuards = config.publicLedger ? [] : [owner];
    app.get("/ledger", ...ledgerGuards, (_req: Request, res: Response) => {
        res.json({
            mode: config.mode,
            entries: treasury.ledger.all().map((e) => ({
                id: e.id,
                type: e.type,
                mode: e.mode,
                at: e.at,
                memo: e.memo ?? null,
                txHash: e.txHash ?? null,
                lines: e.lines.map((l) => ({ account: l.account, amount: l.amount.toString() })),
            })),
            sales: sales.map((s) => ({ ...s, amountUsdcMinor: s.amountUsdcMinor.toString() })),
        });
    });

    // A buyer comes back to what they bought. The id is the secret; the transaction beside it is proof
    // they can check on Base, never the way in.
    if (deps.receipts !== undefined) {
        const receipts = deps.receipts;
        // The data route. `/r/<id>` is the page the buyer visits; the single-page app serves that and
        // fetches this. Sharing one path would mean the browser got JSON instead of the page.
        app.get("/receipt/:id", (req: Request, res: Response) => {
            const raw: unknown = req.params.id;
            const id = typeof raw === "string" ? raw : "";
            const receipt = /^[A-Za-z0-9_-]{10,64}$/.test(id) ? receipts.find(id) : null;
            if (receipt === null) {
                // one answer for a malformed id and an unknown one, so this cannot be probed
                return void res.status(404).json({ error: "no receipt with that link" });
            }
            const found = findBrief(receipt.briefId, receipt.source);
            if (found === null) {
                return void res.status(410).json({
                    error: "that brief is no longer on this server",
                    receipt: { transaction: receipt.transaction, at: receipt.at },
                });
            }
            res.json({
                receipt: {
                    transaction: receipt.transaction,
                    amountUsdcMinor: receipt.amountUsdcMinor,
                    at: receipt.at,
                },
                brief: found.brief,
                provider: found.provider,
                model: found.model,
            });
        });
    }

    // What the storefront can say without anyone paying: the shape of a brief, never its claims.
    app.get("/catalogue", (_req: Request, res: Response) => {
        let latest: { id: string; createdAt: string; themes: string[]; sources: number; facts: number } | null = null;
        try {
            const saved = readBrief();
            latest = {
                id: saved.brief.id,
                createdAt: saved.brief.createdAt,
                themes: saved.brief.themes.map((t) => t.themeId),
                sources: saved.brief.sources.length,
                facts: saved.brief.themes.reduce((a, t) => a + t.claims.length, 0),
            };
        } catch {
            latest = null;
        }
        res.json({
            briefPriceUsd: config.priceUsd,
            researchPriceUsd: config.researchPriceUsd,
            network: config.network,
            asset: config.expectedAsset,
            payTo: config.payTo,
            salesBooked: sales.length,
            revenueUsdcMinor: sales.reduce((a, s) => a + s.amountUsdcMinor, 0n).toString(),
            maxThemes: 3,
            latest,
        });
    });

    // ---- owner routes ----
    //
    // These read or decide what to do with money, so they are gated. The bearer token only proves the
    // caller holds a secret; it is not the owner's signature on a trade. Nothing here ever approves on the
    // owner's behalf: propose, approve and execute are three separate calls on purpose.

    // The mandate is the owner's own constraint set, not an investing feature, so these are mounted
    // whether or not an investing engine is wired in.
    {
        app.get("/mandate", owner, (_req: Request, res: Response) => {
            res.json(mandateView(mandates.current()));
        });

        app.get("/mandate/history", owner, (_req: Request, res: Response) => {
            res.json({
                chainVerified: mandates.verifyChain(),
                versions: mandates.history().map(mandateView),
            });
        });

        // The owner changes their own constraints here. The agent never calls this: a new version is only
        // ever created from the owner's request, and the response says what changed so a mistake is visible.
        app.post("/mandate", owner, (req: Request, res: Response) => {
            const before = mandates.current();
            const parsed = parseTermsUpdate(req.body, before.terms);
            if (!parsed.ok) return void res.status(400).json({ error: "terms were not accepted", details: parsed.errors });
            try {
                const created = deps.updateMandate?.(parsed.terms);
                if (created === undefined) {
                    return void res.status(409).json({ error: "this server cannot change the mandate" });
                }
                res.json({
                    ...mandateView(created),
                    changed: changedTerms(before.terms, created.terms),
                    note: "outstanding approvals are bound to the previous version and now need reapproval",
                });
            } catch (e) {
                res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
            }
        });

    }

    const engine = deps.engine;
    if (engine !== undefined) {
        app.get("/invest/ledger", owner, (_req: Request, res: Response) => {
            res.json({
                mode: engine.treasury.ledger.all()[0]?.mode ?? config.investMode,
                simulatedFills: config.investMode !== "mainnet",
                balances: Object.fromEntries(
                    [...engine.treasury.ledger.balances()].map(([a, v]) => [a, v.toString()]),
                ),
                entries: engine.treasury.ledger.all().map((e) => ({
                    id: e.id, type: e.type, mode: e.mode, at: e.at,
                    memo: e.memo ?? null, briefId: e.briefId ?? null,
                    lines: e.lines.map((l) => ({ account: l.account, amount: l.amount.toString() })),
                })),
                reconcile: reconcileInternal(engine.treasury.ledger),
            });
        });

        app.post("/invest/sync", owner, async (_req: Request, res: Response) => {
            const r = await engine.syncRevenue();
            res.json({
                sales: r.sales,
                unattributedSales: r.unattributedSales,
                briefsCosted: r.briefsCosted,
                unreadableBriefs: r.unreadableBriefs,
                revenueUsdcMinor: r.revenue.toString(),
                costsUsdcMinor: r.costs.toString(),
                investableUsdcMinor: r.investable.toString(),
                settled: r.settled.map((x) => ({ briefId: x.briefId, investableUsdcMinor: x.investable.toString() })),
            });
        });

        app.post("/invest/propose", owner, async (req: Request, res: Response) => {
            const asked: unknown = req.body?.id;
            if (asked !== undefined && (typeof asked !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(asked))) {
                // the id ends up in persisted ledger memos, so it is bounded rather than free text
                return void res.status(400).json({
                    error: "id must be 1 to 64 characters of letters, digits, dot, underscore or hyphen",
                });
            }
            const id = typeof asked === "string" ? asked : `p-${Date.now()}`;
            try {
                const r = await engine.propose(id);
                res.status(r.ok ? 200 : 409).json(r.ok ? { ...r.view, toSign: r.toSign, warnings: r.warnings } : { id, refused: r.reasons });
            } catch (e) {
                res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
            }
        });

        // The owner's EIP-712 signature over the payload /invest/propose returned. There is no unsigned
        // path: the bearer token decides who may reach this route, the signature authorizes the spend.
        app.post("/invest/approve", owner, async (req: Request, res: Response) => {
            const id: unknown = req.body?.id;
            const signature = req.body?.signature;
            if (typeof id !== "string" || id === "") return void res.status(400).json({ error: "id is required" });
            if (typeof signature !== "string" || signature === "") {
                return void res.status(400).json({ error: "signature is required; sign the toSign payload from /invest/propose" });
            }
            try {
                const r = await engine.approve(id, signature);
                res.status(r.ok ? 200 : 409).json(
                    r.ok ? { id, approved: true, expiresAt: r.expiresAt, signer: r.signer } : { id, refused: r.reasons },
                );
            } catch (e) {
                res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
            }
        });

        app.post("/invest/execute", owner, async (req: Request, res: Response) => {
            const id: unknown = req.body?.id;
            if (typeof id !== "string" || id === "") return void res.status(400).json({ error: "id is required" });
            try {
                const r = await engine.execute(id);
                res.status(r.ok ? 200 : 409).json(r.ok ? { id, ...r } : { id, stopped: r.reasons, outcome: r.outcome ?? null });
            } catch (e) {
                res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
            }
        });

        // The brief the proposal was built from, so the desk can show the quote under each leg.
        // The owner must not have to pay their own paid route to see their own catalogue.
        app.get("/invest/brief", owner, (_req: Request, res: Response) => {
            try {
                const saved = readBrief();
                res.json({
                    id: saved.brief.id,
                    createdAt: saved.brief.createdAt,
                    provider: saved.provider,
                    model: saved.model,
                    costUsdcMinor: saved.costUsdcMinor.toString(),
                    themes: saved.brief.themes,
                    sources: saved.brief.sources,
                });
            } catch (e) {
                res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
            }
        });

        app.get("/invest/proposals", owner, (_req: Request, res: Response) => {
            res.json({
                proposals: engine.ids().map((id) => {
                    try {
                        return engine.view(id);
                    } catch {
                        return { id, state: "unknown" };
                    }
                }),
            });
        });
    }

    return { app, treasury, sales, sessions };
}
