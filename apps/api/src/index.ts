import { formatUsdc } from "@surplus/core";
import { loadConfig } from "./config";
import { loadRootEnv } from "./paths";
import { assemble } from "./app";
import { BRIEF_ROUTE } from "./server";

/**
 * The long-running server: one process, a port, and a disk or a database behind it.
 *
 * Everything it serves is assembled by `assemble`, which the serverless entry point uses too. All this
 * file adds is the listener, the banner that says exactly what is live, and a shutdown that finishes
 * requests already in flight.
 */

const envPath = loadRootEnv();

async function main(): Promise<void> {
    const config = loadConfig();
    const a = await assemble(config);
    const { app, backends, mandates, treasury, sales, books } = a;

    const server = app.listen(config.port, () => {
        console.log(`Surplus research endpoint on http://localhost:${config.port}`);
        console.log(`  env         ${envPath ?? "no .env found at the repo root; using the process environment"}`);
        console.log(`  storage     ${backends.kind === "postgres" ? "postgres (DATABASE_URL)" : "append-only JSONL files"}`);
        for (const line of backends.lines) console.log(line);
        console.log(
            `  mandate     v${mandates.current().version} ` +
            `${mandates.current().hash.slice(0, 12)} ` +
            `${a.createdMandate ? "(created from the initial terms)" : "(loaded; stored terms are authoritative)"}`,
        );
        console.log(`  mode        ${config.mode}  (ledger entries are tagged ${config.mode})`);
        console.log(`  network     ${config.network}`);
        console.log(`  facilitator ${config.facilitatorUrl}`);
        console.log(`  paid route  GET ${BRIEF_ROUTE} at ${config.priceUsd}, paid to ${config.payTo}`);
        console.log(
            `  paid route  POST /research at ${config.researchPriceUsd} ` +
            `(cap $${config.researchMaxUsd} per brief, $${config.researchTotalMaxUsd} total, reuse within ${config.briefMaxAgeSeconds}s)`,
        );
        console.log(`  catalogue   ${config.briefsDir} (served by GET /brief, funded by the mandate)`);
        console.log(
            `  ledger      ${books.sales} ` +
            `(${treasury.ledger.all().length} entries restored, ${sales.length} sales, ` +
            `cash ${formatUsdc(treasury.ledger.balance("cash.operating"))} USDC)`,
        );
        console.log(`  free        GET /health, GET /ledger`);
        console.log(`  web         ${a.webDist ?? "not built yet; run npm run build:web"}`);
        console.log(`  issued      ${a.receiptCount} receipt(s)`);
        console.log(`  owner       POST /invest/sync|propose|approve|execute, GET /invest/ledger|proposals, GET /mandate`);
        console.log(`  approvals   EIP-712 signed by ${config.ownerAddress} on chain ${config.approvalChainId}`);
        console.log(`  invest book ${books.invest} [${config.investMode}]${config.investMode === "mainnet" ? "" : " (fills simulated)"}`);
        console.log(`  float       ${formatUsdc(config.openingFloatUsdcMinor)} USDC owner-provided working capital`);
        console.log(`  execution   ${a.execution.executor === null ? `simulated (${a.execution.why})` : `REAL, from ${a.execution.executor.address}`}`);
    });

    // Finish the request in flight before going away. A deploy that cuts a paid request in half would
    // leave a buyer charged by the facilitator with nothing written on this side.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => {
            console.log(`\n${signal} received, finishing open requests before stopping.`);
            server.close(() => {
                void backends.close().then(() => process.exit(0));
            });
            // a request that will not finish must not hold the process open for ever
            setTimeout(() => process.exit(1), 10_000).unref();
        });
    }
}

void main();
