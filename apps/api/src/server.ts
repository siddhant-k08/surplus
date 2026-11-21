import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
    Treasury,
    JsonlLedgerStore,
    flushNewEntries,
    realizedSales,
    reconcileInternal,
    loadLatestBrief,
    formatUsdc,
    type LedgerTx,
    type MandateStore,
    type MandateTerms,
    type MandateVersion,
    type SavedBrief,
} from "@surplus/core";
import type { ApiConfig } from "./config";
import { requireOwner } from "./owner";
import type { InvestingEngine } from "./investing";
import { normalizeThemes, type ResearchService } from "./research";
import { parseTermsUpdate, changedTerms } from "./terms";

export const BRIEF_ROUTE = "/brief";
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
    /** When given, the ledger is loaded from this file on boot and appended to after every sale. */
    store?: JsonlLedgerStore;
    /** When given, the owner-gated investing routes are mounted. */
    engine?: InvestingEngine;
    /** When given, the paid on-demand research route is mounted. */
    research?: ResearchService;
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
    const { config, store, mandates } = deps;
    const readBrief = deps.readBrief ?? ((): SavedBrief => loadLatestBrief(config.briefsDir));

    // Replaying the stored entries restores the balances and, importantly, the dedup index: a settlement
    // that arrives again after a restart is refused by the ledger rather than booked a second time.
    const ledger = store?.loadLedger();
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
                briefId: readBrief().brief.id,
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
                if (store !== undefined) {
                    // flush straight after booking: a crash before this loses the entry, and the onchain
                    // payment would then have to be reconciled by hand
                    persistedId = flushNewEntries(treasury.ledger, store, persistedId);
                }
                console.log(`booked ${formatUsdc(amount)} USDC (tx ${result.transaction})`);
            }
        });

    const app = express();
    app.disable("x-powered-by");
    // a small cap: these bodies carry an id, never a document
    app.use(express.json({ limit: "16kb" }));

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
            latestBrief: briefId,
            latestBriefCreatedAt: createdAt,
            salesBooked: sales.length,
        });
    });

    app.get(BRIEF_ROUTE, (_req: Request, res: Response) => {
        const saved = readBrief();
        res.json({
            brief: saved.brief,
            provider: saved.provider,
            model: saved.model,
            disclaimer: saved.brief.disclaimer,
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
                res.json({
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

    // free, read-only: the chronological ledger, so a buyer can see the sale was booked
    app.get("/ledger", (_req: Request, res: Response) => {
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

    // ---- owner routes ----
    //
    // These read or decide what to do with money, so they are gated. The bearer token only proves the
    // caller holds a secret; it is not the owner's signature on a trade. Nothing here ever approves on the
    // owner's behalf: propose, approve and execute are three separate calls on purpose.
    const owner = requireOwner(config.ownerToken);

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

        app.post("/invest/sync", owner, (_req: Request, res: Response) => {
            const r = engine.syncRevenue();
            res.json({
                sales: r.sales,
                unattributedSales: r.unattributedSales,
                briefsCosted: r.briefsCosted,
                revenueUsdcMinor: r.revenue.toString(),
                costsUsdcMinor: r.costs.toString(),
                investableUsdcMinor: r.investable.toString(),
                settled: r.settled.map((x) => ({ briefId: x.briefId, investableUsdcMinor: x.investable.toString() })),
            });
        });

        app.post("/invest/propose", owner, async (req: Request, res: Response) => {
            const id = typeof req.body?.id === "string" && req.body.id !== "" ? req.body.id : `p-${Date.now()}`;
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
            const id = req.body?.id;
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
            const id = req.body?.id;
            if (typeof id !== "string" || id === "") return void res.status(400).json({ error: "id is required" });
            try {
                const r = await engine.execute(id);
                res.status(r.ok ? 200 : 409).json(r.ok ? { id, ...r } : { id, stopped: r.reasons, outcome: r.outcome ?? null });
            } catch (e) {
                res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
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

    return { app, treasury, sales };
}
