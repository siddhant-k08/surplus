import {
    openMandateFrom,
    parseUsdc as u,
    BASE_REGISTRY,
    openLedger,
    formatUsdc,
    loadAllTokens,
    crossCheck,
    loadLiquidityScores,
    quoteLegs,
    BASE_REGISTRY as REGISTRY,
    EdgarClient,
    EdgarDocProvider,
    createAnthropicClient,
    createGeminiClient,
    type CandidateCompany,
    type SavedBrief,
    type LlmClient,
    type MandateTerms,
} from "@surplus/core";
import { InvestingEngine, type MarketData } from "./investing";
import { ResearchService } from "./research";
import { openBackends, bookNames } from "./backends";
import { log } from "./log";
import { openExecutor } from "./executor";
import { verifyApprovalSignature } from "./signature";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express } from "express";
import type { ApiConfig } from "./config";
import { buildServer, facilitatorReach } from "./server";
import { openFacilitator } from "./facilitator";
import { fromRepoRoot } from "./paths";
import type { Backends } from "./backends";
import type { Treasury } from "@surplus/core";
import type { BookedSale } from "./server";
import type { MandateStore } from "@surplus/core";

/**
 * Assembling the running agent: storage, mandate, research, investing and the HTTP routes.
 *
 * Split out from the process entry point because there are two ways this runs. A long-running server
 * builds it once and listens on a port. A serverless host builds it per cold start and hands it a
 * request. Both must assemble exactly the same thing, so neither can drift into being a special case.
 *
 * The endpoint sells research; it does not invest. The treasury still settles against a real mandate, so
 * the terms are the same reserve and surplus rules the investing side uses, with the official registry
 * as the eligible set.
 */

/**
 * The mandate the agent starts with on a first run only. Once a mandate is stored, that one is
 * authoritative and these values are never applied again: see `openMandate`.
 */
const initialTerms: MandateTerms = {
    eligible: BASE_REGISTRY.map((r) => r.address),
    themes: [
        { id: "ai-compute", targetBps: 5000 },
        { id: "platform-giants", targetBps: 3000 },
        { id: "longevity-biotech", targetBps: 2000 },
    ],
    maxCompanyBps: 4000,
    investShareBps: 5000,
    maxTradeUsdc: u("1.00"),
    minTradeUsdc: u("0.05"),
    /*
     * The reserve is runway, not a round number: roughly 20 further briefs at the measured
     * $0.021087 each. Expressed this way it tracks what the agent actually costs to operate and
     * moves correctly when the model changes, where a fixed figure silently stops meaning anything.
     */
    reserveTargetUsdc: u("0.42"),
    maxSlippageBps: 100,
    driftToleranceBps: 100,
    approvalExpirySeconds: 600,
    // A new deployment starts cautious. An existing stored mandate is untouched by this.
    investOnlyWhenAhead: true,
};

function env(name: string): string {
    const v = process.env[name];
    if (v === undefined || v.trim() === "") throw new Error(`${name} is not set; on-demand research needs it`);
    return v.trim();
}

/** Everything a caller needs to serve, report on, or shut down the assembled agent. */
export interface Assembled {
    app: Express;
    config: ApiConfig;
    backends: Backends;
    mandates: MandateStore;
    /** True when this start created mandate version 1 from `initialTerms`. */
    createdMandate: boolean;
    treasury: Treasury;
    sales: BookedSale[];
    receiptCount: number;
    /** Where the two books live, named for the banner. */
    books: { sales: string; invest: string };
    /** The built web app, or null when it has not been built. */
    webDist: string | null;
    /** Why fills are simulated, or the address real ones would come from. */
    execution: ReturnType<typeof openExecutor>;
    /** Who settles payments: someone else's server, or this process. Named in the banner. */
    facilitator: ReturnType<typeof openFacilitator>;
    /** What the catalogue cost to produce, so the banner can check the price against it. */
    catalogueCost: { totalUsdcMinor: bigint; briefs: number };
}

/** What a re-assembly must do differently from a cold start. */
export interface AssembleOptions {
    /**
     * Storage that is already open, so a refresh reuses the connection instead of opening another.
     *
     * Without this a refresh would leak a database connection per rebuild, which on a provider with a
     * connection ceiling is a worse problem than the staleness being fixed.
     */
    backends?: Backends;
    /**
     * Resolve journaled swaps against the chain. True on a cold start, false on a refresh.
     *
     * Recovery belongs to taking over from a predecessor that may have signed a swap and died. A
     * refresh happens because another instance wrote a ledger entry, which is an ordinary event, and
     * reaching for the chain every time one does would turn a read into an onchain operation.
     */
    recover?: boolean;
}

export async function assemble(config: ApiConfig, opts: AssembleOptions = {}): Promise<Assembled> {

    // Files or Postgres, decided by DATABASE_URL alone. Everything below is written against the ports,
    // so nothing here knows or cares which one answered.
    const backends = opts.backends ?? await openBackends(config);
    const books = bookNames(config, backends);
    const salesStore = backends.sales;
    const salesLedgerLoaded = await openLedger(salesStore);
    const investStore = backends.invest;
    const investLedger = await openLedger(investStore);

    // One mandate, shared by the sales treasury and the investing engine, so both always see the same
    // version. Two stores would drift apart the moment the owner changed a term.
    const { mandates, created } = await openMandateFrom(backends.mandate, initialTerms);
    const terms = mandates.current().terms;

    // Market data is fetched per call rather than cached: a quote older than 25 s is refused by the gates,
    // and the trusted token set can change under us.
    const market = async (): Promise<MarketData> => {
        const { tokens } = await loadAllTokens();
        const trusted = crossCheck(tokens).trusted;
        const liquidity = await loadLiquidityScores(trusted.map((t) => t.address));
        const decimals = new Map(trusted.map((t) => [t.address, t.decimals]));
        return {
            trusted,
            liquidity: liquidity.scores,
            quote: (legs) => quoteLegs(legs, decimals, { slippageBps: terms.maxSlippageBps }),
        };
    };

    // On-demand research. The model client and SEC provider are built once; the spend cap is applied per
    // brief inside the service, and the config refuses to let the cap exceed the sale price.
    // The owner's catalogue and the buyer-commissioned collection, kept apart on purpose: one store would
    // let the cheap route serve a premium custom brief and would feed unfunded themes to the allocator.
    const catalogue = backends.catalogue;
    const customBriefs = backends.custom;

    /** The brief `GET /brief` sells. Throws with the command that produces one when the catalogue is empty. */
    const newestCatalogueBrief = async (): Promise<SavedBrief> => {
        const newest = (await catalogue.list())[0];
        if (newest === undefined) {
            throw new Error(`No briefs in ${config.briefsDir}. Run "npx tsx scripts/demo-research.ts" first.`);
        }
        return newest;
    };

    /** A brief a receipt names, in whichever collection it was sold from. */
    const briefById = async (briefId: string, source: "catalogue" | "custom"): Promise<SavedBrief | null> => {
        const from = source === "custom" ? customBriefs : catalogue;
        return (await from.list()).find((b) => b.brief.id === briefId) ?? null;
    };

    const research = new ResearchService({
        // buyer-commissioned work lives apart from the owner's catalogue
        briefs: customBriefs,
        companies: async (): Promise<readonly CandidateCompany[]> => {
            const { tokens } = await loadAllTokens();
            const names = new Map(REGISTRY.map((r) => [r.address.toLowerCase(), r.name]));
            return crossCheck(tokens).trusted.map((t) => ({
                asset: t.address.toLowerCase(),
                symbol: t.symbol,
                name: names.get(t.address.toLowerCase()) ?? t.name,
            }));
        },
        docs: () => new EdgarDocProvider(new EdgarClient({ userAgent: env("SEC_USER_AGENT") })),
        llm: (): LlmClient =>
            env("LLM_PROVIDER") === "anthropic"
                ? createAnthropicClient({ apiKey: env("ANTHROPIC_API_KEY"), model: env("RESEARCH_MODEL") })
                : createGeminiClient({ apiKey: env("GEMINI_API_KEY"), model: env("RESEARCH_MODEL") }),
        provider: env("LLM_PROVIDER"),
        model: env("RESEARCH_MODEL"),
        priceInputPerMTokUsd: Number(env("PRICE_INPUT_PER_MTOK_USD")),
        priceOutputPerMTokUsd: Number(env("PRICE_OUTPUT_PER_MTOK_USD")),
        reservations: backends.reservations,
        maxSpendUsd: config.researchMaxUsd,
        totalMaxSpendUsd: config.researchTotalMaxUsd,
        maxAgeSeconds: config.briefMaxAgeSeconds,
    });

    /** Only the owner route reaches this. A new version is appended, never rewritten. */
    const updateMandate = async (next: MandateTerms) => {
        const created = mandates.create(next);
        await backends.mandate.append(created);
        return created;
    };

    // Real fills are off unless mainnet is deliberately enabled, a cap is set and a key is present.
    const execution = openExecutor({
        journal: backends.executions,
        mainnetEnabled: process.env.MAINNET_ENABLED === "true",
        rpcUrl: process.env.BASE_RPC_URL ?? "",
        privateKey: process.env.EXECUTION_PRIVATE_KEY ?? "",
        ...(process.env.MAINNET_SPEND_CAP_USDC !== undefined && process.env.MAINNET_SPEND_CAP_USDC !== ""
            ? { spendCapUsdcMinor: u(process.env.MAINNET_SPEND_CAP_USDC) }
            : {}),
    });

    const engine = new InvestingEngine({
        mode: config.investMode,
        openingFloat: config.openingFloatUsdcMinor,
        mandates,
        // Proposals are built from the owner's catalogue only: a buyer's themes are not funded by the
        // mandate. Cost accounting covers both, because a buyer's brief cost the agent real money too.
        readBrief: async () => newestCatalogueBrief(),
        allBriefs: async () => [...(await catalogue.list()), ...(await customBriefs.list())],
        briefProblems: async () => [...(await catalogue.problems()), ...(await customBriefs.problems())],
        salesLedger: () => salesLedgerLoaded.all(),
        // Real swaps only when there is an executor, which refuses to exist without mainnet deliberately
        // enabled, a spend cap and a key. Otherwise fills are simulated and labelled as such.
        ...(execution.executor !== null && { executor: execution.executor }),
        market,
        ledger: investLedger,
        sink: investStore,
        chainId: config.approvalChainId,
        verifyApproval: ({ approval, signature }) =>
            verifyApprovalSignature({
                approval,
                signature,
                chainId: config.approvalChainId,
                ownerAddress: config.ownerAddress,
            }),
    });

    // Before serving anything: a swap this instance's predecessor signed may have landed on the chain
    // while nothing was left to notice. Resolving those against the chain is the first thing that must
    // happen, because every number below is wrong until it has.
    if (execution.executor !== null && opts.recover !== false) {
        const resolved = await execution.executor.recover();
        for (const r of resolved) {
            log.info("execution_recovered", `recovered execution ${r.key}: ${r.outcome}`, {
                key: r.key,
                outcome: r.outcome,
            });
        }
    }

    const receipts = backends.receipts;
    const receiptCount = await receipts.count();
    // Chosen once and shared, so the health check reports the facilitator that is actually settling
    // rather than a url the process may not be talking to.
    const facilitator = openFacilitator(config);
    // Before serving: an RPC on the wrong chain would otherwise be discovered mid-settlement, holding a
    // buyer's signed authorization with nothing useful to say about it.
    await facilitator.verifyChain?.();

    const { app, treasury, sales } = buildServer({
        config, mandates, ledger: salesLedgerLoaded, sink: salesStore, facilitator,
        engine, research, updateMandate, receipts, sessions: backends.sessions,
        throttle: backends.throttle,
        storage: backends.kind,
        storageCheck: () => backends.check(),
        facilitatorCheck: () => facilitatorReach(facilitator, config.facilitatorUrl),
        readBrief: newestCatalogueBrief, findBrief: briefById,
        catalogueBriefs: () => catalogue.list(),
        ...(execution.executor !== null && { positions: () => execution.executor!.positions() }),
        ...(execution.executor !== null && {
            executionStatus: async () => {
                const executor = execution.executor!;
                const { spent, remaining } = await executor.budget();
                const unresolved = await backends.executions.unresolved();
                return {
                    willSendRealSwaps: config.investMode === "mainnet",
                    ...(config.investMode !== "mainnet" && {
                        why: `INVEST_MODE is ${config.investMode}, so fills are simulated`,
                    }),
                    address: executor.address,
                    capUsdcMinor: (spent + remaining).toString(),
                    spentUsdcMinor: spent.toString(),
                    remainingUsdcMinor: remaining.toString(),
                    unresolved: unresolved.map((r) => ({
                        key: r.key,
                        symbol: r.symbol,
                        txHash: r.txHash,
                        usdcInMinor: r.usdcInMinor.toString(),
                    })),
                };
            },
        }),
    });

    // The built owner desk and storefront, served by the same process that serves the API. Mounted last
    // so a route added above always wins over a file with the same name.
    const webDist = fromRepoRoot("apps/web/dist");
    if (existsSync(webDist)) {
        app.use(express.static(webDist, { index: "index.html" }));
        // A single page app: anything unmatched that is not an API path falls back to index.html.
        // `catalogue` is on the list because the app has pages at /themes and /filings while the API
        // has data at /catalogue/themes and /catalogue/filings: without it, a catalogue path the
        // server did not register would answer a machine with a web page instead of a 404.
        app.get(/^(?!\/(?:health|brief|catalogue|research|ledger|mandate|invest|auth|receipt)\b).*/, (_req, res) => {
            res.sendFile(join(webDist, "index.html"));
        });
    }

    return {
        app,
        config,
        backends,
        mandates,
        createdMandate: created,
        treasury,
        sales,
        receiptCount,
        books,
        webDist: existsSync(webDist) ? webDist : null,
        execution,
        facilitator,
        catalogueCost: {
            totalUsdcMinor: await catalogue.totalCostUsdcMinor(),
            briefs: (await catalogue.list()).length,
        },
    };
}
