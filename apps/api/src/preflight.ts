import {
    loadAllTokens,
    crossCheck,
    loadLiquidityScores,
    quoteLegs,
    preTradeChecks,
    blockReasons,
    warnings,
    swapPlan,
    parseUsdc,
    formatUsdc,
    type Leg,
} from "@surplus/core";
import { loadConfig } from "./config";
import { loadRootEnv } from "./paths";
import { openExecutor } from "./executor";

/**
 * A rehearsal of the one thing that cannot be undone.
 *
 * Everything a real swap does, stopping before the broadcast: the trusted set, liquidity, a live quote,
 * the pre-trade gates, the wallet's balances, the calldata, and the chain's own answer to whether the
 * swap would succeed. Nothing is signed and nothing is sent.
 *
 * It exists because the first real swap should be boring. Anything this cannot answer in advance is
 * something that would otherwise be discovered with money on the line.
 *
 *   npm run preflight -w @surplus/api -- --symbol=NVDAc --usdc=0.50
 */

const WHEN_NAV_IS_STALE =
    "\nNote: the NAV reference is stale, so the deviation gate did not run. That is the designed\n" +
    "behaviour, and it means the one check on paying too far above NAV is inactive right now, which is\n" +
    "the case whenever the underlying market is closed. Prefer US market hours for a first real swap.";

function arg(name: string, fallback: string): string {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found === undefined ? fallback : found.slice(name.length + 3);
}

async function main(): Promise<void> {
    loadRootEnv();
    const config = loadConfig();
    const symbol = arg("symbol", "NVDAc");
    const usdcIn = parseUsdc(arg("usdc", "0.50"));

    console.log(`Preflight for ${formatUsdc(usdcIn)} USDC of ${symbol}. Nothing is signed or sent.\n`);

    const { tokens } = await loadAllTokens();
    const trusted = crossCheck(tokens).trusted;
    const token = trusted.find((t) => t.symbol === symbol);
    if (token === undefined) {
        throw new Error(
            `${symbol} is not in the trusted set right now. Trusted: ${trusted.map((t) => t.symbol).join(", ")}`,
        );
    }

    const liquidity = await loadLiquidityScores([token.address]);
    const decimals = new Map(trusted.map((t) => [t.address, t.decimals]));
    const leg: Leg = { symbol, asset: token.address, theme: "preflight", usdcIn, maxSlippageBps: 100 };
    const quoted = await quoteLegs([leg], decimals, { slippageBps: 100 });
    const quote = quoted.quotes.get(token.address.toLowerCase());
    if (quote === undefined) {
        throw new Error(`no quote for ${symbol}: ${quoted.errors.get(token.address.toLowerCase()) ?? "unknown"}`);
    }

    // the same gates the engine applies before it lets a trade through
    const gates = preTradeChecks({
        legs: [leg],
        quotes: quoted.quotes,
        tokens: new Map(trusted.map((t) => [t.address, t])),
        liquidity: liquidity.scores,
        now: new Date(),
    });
    const blocks = blockReasons(gates);
    const soft = warnings(gates);

    // The NAV deviation gate only blocks when NAV is fresh, which means it is inert exactly when the
    // underlying market is closed: the hours when the premium to NAV is widest and least checkable.
    const navStale = soft.some((w) => w.includes("deviation check skipped"));
    const price = quoted.prices.get(token.address.toLowerCase());
    console.log("market");
    console.log(`  liquidity score   ${liquidity.scores.get(token.address.toLowerCase()) ?? "unknown"} (the gate needs 2)`);
    console.log(`  quoted price      ${price === undefined ? "unknown" : formatUsdc(price)} USDC per whole token`);
    console.log(`  NAV reference     ${token.navPrice ?? "unknown"}`);
    console.log(`  gates             ${blocks.length === 0 ? "pass" : `BLOCKED: ${blocks.join("; ")}`}`);
    for (const w of soft) console.log(`  warning           ${w}`);

    const plan = swapPlan([leg], config.openingFloatUsdcMinor > 0n ? usdcIn : usdcIn);
    const order = plan[0]!;

    const execution = openExecutor({
        mainnetEnabled: process.env.MAINNET_ENABLED === "true",
        rpcUrl: process.env.BASE_RPC_URL ?? "",
        privateKey: process.env.EXECUTION_PRIVATE_KEY ?? "",
        ...(process.env.MAINNET_SPEND_CAP_USDC !== undefined && process.env.MAINNET_SPEND_CAP_USDC !== ""
            ? { spendCapUsdcMinor: parseUsdc(process.env.MAINNET_SPEND_CAP_USDC) }
            : {}),
    });

    console.log("\nwallet");
    if (execution.executor === null) {
        console.log(`  no executor       ${execution.why}`);
        console.log("\nNot ready. The market side above is real; the wallet side needs the settings in docs/DEPLOY.md.");
        return;
    }

    console.log(`  address           ${execution.executor.address}`);
    const result = await execution.executor.preflight(order, quote);
    for (const check of result.checks) {
        console.log(`  ${check.ok ? "ok  " : "FAIL"}              ${check.name}: ${check.detail}`);
    }

    const ready = result.ok && blocks.length === 0;
    console.log(
        `\n${ready ? "Ready." : "Not ready."} ` +
        (ready
            ? "A real run would send one swap. Nothing was sent by this."
            : "Fix what failed above before sending anything."),
    );
    if (navStale) console.log(WHEN_NAV_IS_STALE);
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
