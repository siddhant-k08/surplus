import { parseUsdc as u, BASE_REGISTRY, JsonlLedgerStore, formatUsdc, type MandateTerms } from "@surplus/core";
import { loadConfig } from "./config";
import { buildServer, BRIEF_ROUTE } from "./server";
import { loadRootEnv } from "./paths";

const envPath = loadRootEnv();

/**
 * The endpoint sells research; it does not invest. The treasury still settles against a real mandate, so the
 * terms are the same reserve and surplus rules the investing side uses, with the official registry as the
 * eligible set. The investing side runs in demo-live.ts against the same ledger rules.
 */
const terms: MandateTerms = {
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

function main(): void {
    const config = loadConfig();
    const store = new JsonlLedgerStore(config.ledgerPath);
    const { app, treasury, sales } = buildServer({ config, terms, store });

    app.listen(config.port, () => {
        console.log(`Surplus research endpoint on http://localhost:${config.port}`);
        console.log(`  env         ${envPath ?? "no .env found at the repo root; using the process environment"}`);
        console.log(`  mode        ${config.mode}  (ledger entries are tagged ${config.mode})`);
        console.log(`  network     ${config.network}`);
        console.log(`  facilitator ${config.facilitatorUrl}`);
        console.log(`  paid route  GET ${BRIEF_ROUTE} at ${config.priceUsd}, paid to ${config.payTo}`);
        console.log(`  briefs      ${config.briefsDir}`);
        console.log(
            `  ledger      ${config.ledgerPath} ` +
            `(${treasury.ledger.all().length} entries restored, ${sales.length} sales, ` +
            `cash ${formatUsdc(treasury.ledger.balance("cash.operating"))} USDC)`,
        );
        console.log(`  free        GET /health, GET /ledger`);
    });
}

main();
