import {
    JsonlMandateStore,
    openMandate,
    parseUsdc as u,
    BASE_REGISTRY,
    JsonlLedgerStore,
    formatUsdc,
    loadAllTokens,
    crossCheck,
    loadLiquidityScores,
    quoteLegs,
    loadLatestBrief,
    loadBriefs,
    BASE_REGISTRY as REGISTRY,
    EdgarClient,
    EdgarDocProvider,
    createAnthropicClient,
    createGeminiClient,
    type CandidateCompany,
    type LlmClient,
    type MandateTerms,
} from "@surplus/core";
import { InvestingEngine, type MarketData } from "./investing";
import { ResearchService } from "./research";
import { verifyApprovalSignature } from "./signature";
import { loadConfig } from "./config";
import { buildServer, BRIEF_ROUTE } from "./server";
import { loadRootEnv } from "./paths";

const envPath = loadRootEnv();

/**
 * The endpoint sells research; it does not invest. The treasury still settles against a real mandate, so the
 * terms are the same reserve and surplus rules the investing side uses, with the official registry as the
 * eligible set. The investing side runs in demo-live.ts against the same ledger rules.
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
    reserveTargetUsdc: u("2.00"),
    maxSlippageBps: 100,
    driftToleranceBps: 100,
    approvalExpirySeconds: 600,
};

function env(name: string): string {
    const v = process.env[name];
    if (v === undefined || v.trim() === "") throw new Error(`${name} is not set; on-demand research needs it`);
    return v.trim();
}

function main(): void {
    const config = loadConfig();
    const store = new JsonlLedgerStore(config.ledgerPath);

    // One mandate, shared by the sales treasury and the investing engine, so both always see the same
    // version. Two stores would drift apart the moment the owner changed a term.
    const mandateStore = new JsonlMandateStore(config.mandatePath);
    const { mandates, created } = openMandate(mandateStore, initialTerms);
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
    const research = new ResearchService({
        briefsDir: config.briefsDir,
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
        maxSpendUsd: config.researchMaxUsd,
        maxAgeSeconds: config.briefMaxAgeSeconds,
    });

    /** Only the owner route reaches this. A new version is appended, never rewritten. */
    const updateMandate = (next: MandateTerms) => {
        const created = mandates.create(next);
        mandateStore.append(created);
        return created;
    };

    const engine = new InvestingEngine({
        mode: config.investMode,
        openingFloat: config.openingFloatUsdcMinor,
        mandates,
        readBrief: () => loadLatestBrief(config.briefsDir),
        allBriefs: () => loadBriefs(config.briefsDir),
        salesLedger: () => store.load(),
        market,
        store: new JsonlLedgerStore(config.investLedgerPath),
        chainId: config.approvalChainId,
        verifyApproval: ({ approval, signature }) =>
            verifyApprovalSignature({
                approval,
                signature,
                chainId: config.approvalChainId,
                ownerAddress: config.ownerAddress,
            }),
    });

    const { app, treasury, sales } = buildServer({ config, mandates, store, engine, research, updateMandate });

    app.listen(config.port, () => {
        console.log(`Surplus research endpoint on http://localhost:${config.port}`);
        console.log(`  env         ${envPath ?? "no .env found at the repo root; using the process environment"}`);
        console.log(
            `  mandate     ${config.mandatePath} v${mandates.current().version} ` +
            `${mandates.current().hash.slice(0, 12)} ${created ? "(created from the initial terms)" : "(loaded; stored terms are authoritative)"}`,
        );
        console.log(`  mode        ${config.mode}  (ledger entries are tagged ${config.mode})`);
        console.log(`  network     ${config.network}`);
        console.log(`  facilitator ${config.facilitatorUrl}`);
        console.log(`  paid route  GET ${BRIEF_ROUTE} at ${config.priceUsd}, paid to ${config.payTo}`);
        console.log(`  paid route  POST /research at ${config.researchPriceUsd} (cap $${config.researchMaxUsd} per brief, reuse within ${config.briefMaxAgeSeconds}s)`);
        console.log(`  briefs      ${config.briefsDir}`);
        console.log(
            `  ledger      ${config.ledgerPath} ` +
            `(${treasury.ledger.all().length} entries restored, ${sales.length} sales, ` +
            `cash ${formatUsdc(treasury.ledger.balance("cash.operating"))} USDC)`,
        );
        console.log(`  free        GET /health, GET /ledger`);
        console.log(`  owner       POST /invest/sync|propose|approve|execute, GET /invest/ledger|proposals, GET /mandate`);
        console.log(`  approvals   EIP-712 signed by ${config.ownerAddress} on chain ${config.approvalChainId}`);
        console.log(`  invest book ${config.investLedgerPath} [${config.investMode}]${config.investMode === "mainnet" ? "" : " (fills simulated)"}`);
        console.log(`  float       ${formatUsdc(config.openingFloatUsdcMinor)} USDC owner-provided working capital`);
    });
}

main();
