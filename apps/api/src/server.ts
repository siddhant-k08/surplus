import express, { type Express, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
    Treasury,
    MandateStore,
    loadLatestBrief,
    formatUsdc,
    type MandateTerms,
    type SavedBrief,
} from "@surplus/core";
import type { ApiConfig } from "./config";

export const BRIEF_ROUTE = "/brief";

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
    terms: MandateTerms;
    /** Overridable so tests can run without the docs/briefs directory. */
    readBrief?: () => SavedBrief;
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
    const { config, terms } = deps;
    const readBrief = deps.readBrief ?? ((): SavedBrief => loadLatestBrief(config.briefsDir));

    const mandates = new MandateStore();
    mandates.create(terms);
    const treasury = new Treasury({ mode: config.mode, mandates });
    const sales: BookedSale[] = [];

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
                console.log(`booked ${formatUsdc(amount)} USDC (tx ${result.transaction})`);
            }
        });

    const app = express();
    app.disable("x-powered-by");

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

    return { app, treasury, sales };
}
