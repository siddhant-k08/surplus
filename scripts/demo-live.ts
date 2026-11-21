import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
    loadLatestBrief,
    loadAllTokens,
    JsonlLedgerStore,
    realizedSales,
    crossCheck,
    loadLiquidityScores,
    toCandidates,
    validateBrief,
    allocate,
    swapPlan,
    swapPlanTotal,
    describeSwapPlan,
    quoteLegs,
    preTradeChecks,
    blockReasons,
    warnings,
    driftBps,
    navStatus,
    MandateStore,
    Treasury,
    reconcileInternal,
    parseUsdc as u,
    formatUsdc,
    type Claim,
    type ThemeInput,
} from "../packages/core/src/index";

const SLIPPAGE_BPS = 100;
// Resolved from this file, not the working directory: a relative default silently reads nothing when the
// script is run from anywhere but the repo root.
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
const BRIEFS_DIR = fromRoot(process.env.BRIEFS_DIR ?? "docs/briefs");
const LEDGER_PATH = fromRoot(process.env.LEDGER_PATH ?? "data/ledger-testnet.jsonl");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    console.log("Loading the token list...");
    const { tokens } = await loadAllTokens();
    const check = crossCheck(tokens);
    console.log(
        `API tokens ${tokens.length}, trusted ${check.trusted.length}, ` +
        `missing from API ${check.missingFromApi.length}, symbol mismatches ${check.symbolMismatch.length}`,
    );
    if (check.trusted.length === 0) throw new Error("No trusted tokens, stopping");

    const bySymbol = new Map(check.trusted.map((t) => [t.symbol, t]));
    const decimals = new Map(check.trusted.map((t) => [t.address, t.decimals]));
    const symbolOf = new Map(check.trusted.map((t) => [t.address, t.symbol]));

    console.log("Loading pool liquidity (one request per token, spaced out)...");
    const liquidity = await loadLiquidityScores(check.trusted.map((t) => t.address));

    const saved = loadLatestBrief(BRIEFS_DIR);
    const brief = saved.brief;
    console.log(
        `\nUsing brief ${brief.id} from ${saved.file}\n` +
        `  created ${brief.createdAt}, ${saved.provider} ${saved.model}, ` +
        `metered cost $${saved.costUsd.toFixed(4)} (${formatUsdc(saved.costUsdcMinor)} USDC)`,
    );

    // The brief was written earlier against the token list as it stood then. Re-check it against the set that
    // is trusted right now, and refuse to trade on a brief that no longer validates.
    const eligible = new Set(check.trusted.map((t) => t.address.toLowerCase()));
    const issues = validateBrief(brief, { eligible });
    if (issues.length > 0) {
        console.log(`Brief failed validation against the current trusted set (${issues.length} issues):`);
        for (const i of issues) console.log(`  ${i.path} ${i.rule}: ${i.message}`);
        throw new Error("Refusing to trade on a brief that does not validate");
    }
    console.log("  brief validates against the token set trusted right now");

    const claimById = new Map<string, Claim>();
    for (const t of brief.themes) for (const c of t.claims) claimById.set(c.id, c);

    const themes: ThemeInput[] = brief.themes.map((t) => ({
        id: t.themeId,
        candidates: toCandidates(t.fits, liquidity.scores, 3, 1),
    }));
    for (const t of brief.themes) {
        if (t.gap) console.log(`  theme ${t.themeId} is a declared gap: ${t.gapReason ?? "no reason given"}`);
    }

    const mandates = new MandateStore();
    mandates.create({
        eligible: check.trusted.map((t) => t.address),
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
        maxSlippageBps: SLIPPAGE_BPS,
        driftToleranceBps: 100,
        approvalExpirySeconds: 600,
    });

    // Revenue comes from the paid endpoint's own ledger when it has sales. The investing loop runs in its
    // own `sim` book so simulated fills can never be written into the real testnet book; the mirrored
    // revenue entry names the transactions it stands for, so the provenance is checkable.
    const realSales = realizedSales(new JsonlLedgerStore(LEDGER_PATH).load());
    const realRevenue = realSales.reduce((a, x) => a + x.amountUsdcMinor, 0n);
    const useReal = realRevenue > 0n && !process.argv.includes("--simulate-revenue");

    const tr = new Treasury({ mode: "sim", mandates });
    tr.ledger.post({
        type: "OPENING_BALANCE", mode: "sim", memo: "opening reserve (simulated)",
        lines: [{ account: "reserve", amount: u("1.50") }, { account: "equity.opening", amount: u("-1.50") }],
    });

    if (useReal) {
        console.log(`\nRevenue from the paid endpoint: ${realSales.length} real sale(s) in ${LEDGER_PATH}`);
        for (const x of realSales) {
            console.log(`  ${formatUsdc(x.amountUsdcMinor)} USDC [${x.mode}] tx ${x.transaction}`);
        }
        tr.receivePayment({
            id: `mirror-${brief.id}`,
            briefId: brief.id,
            amount: realRevenue,
            memo: `mirrors ${realSales.length} real sale(s): ${realSales.map((x) => x.transaction.slice(0, 10)).join(", ")}`,
        });
    } else {
        const why = realRevenue > 0n ? "forced by --simulate-revenue" : `no sales found in ${LEDGER_PATH}`;
        console.log(`\nRevenue: SIMULATED sale of ${formatUsdc(u("3.00"))} (${why})`);
        tr.receivePayment({ id: `pay-${brief.id}`, briefId: brief.id, amount: u("3.00"), memo: "SIMULATED sale" });
    }

    // the model cost is the real metered cost of the brief above, whichever revenue was used
    tr.accrueCost({
        id: `llm-${brief.id}`,
        briefId: brief.id,
        kind: "llm",
        amount: saved.costUsdcMinor,
        memo: "metered estimate at paid-tier rates",
    });
    const s = tr.settleBrief(brief.id);
    console.log(
        `Revenue ${formatUsdc(useReal ? realRevenue : u("3.00"))}${useReal ? " (REAL)" : " (SIMULATED)"}, ` +
        `real model cost ${formatUsdc(saved.costUsdcMinor)}, net ${formatUsdc(s.net)}, ` +
        `reserve top-up ${formatUsdc(s.reserveTopUp)}, surplus ${formatUsdc(s.surplus)}, ` +
        `investable ${formatUsdc(s.investable)}`,
    );

    if (s.investable === 0n) {
        // this is the designed behaviour, not a failure: the agent does not invest what it has not earned
        console.log("\nNothing to invest, and that is correct. Why:");
        if (s.shortfall > 0n) {
            console.log(`  the brief cost ${formatUsdc(saved.costUsdcMinor)} and earned ${formatUsdc(useReal ? realRevenue : u("3.00"))}, a shortfall of ${formatUsdc(s.shortfall)}`);
        } else if (s.reserveTopUp > 0n && s.surplus === 0n) {
            console.log(`  all ${formatUsdc(s.reserveTopUp)} of the net went to the protected reserve, which is still below its target of ${formatUsdc(mandates.current().terms.reserveTargetUsdc)}`);
        } else {
            console.log(`  the surplus of ${formatUsdc(s.surplus)} leaves nothing once the invest share is applied`);
        }
        console.log("  sell more briefs, raise BRIEF_PRICE_USD, or lower reserveTargetUsdc for a demo run.");
        console.log("  To rehearse the investing path on simulated revenue: npx tsx scripts/demo-live.ts --simulate-revenue");
        return;
    }

    const alloc = allocate({ investable: tr.ledger.balance("surplus.investable"), themes, terms: mandates.current().terms });
    console.log("\nProposed legs, each with the verified claim and quote behind it:");
    for (const l of alloc.legs) {
        console.log(`  ${l.symbol.padEnd(7)} ${formatUsdc(l.usdcIn)} USDC (${l.theme})`);
        const fitted = brief.themes.find((t) => t.themeId === l.theme)?.fits.find((f) => f.symbol === l.symbol);
        for (const id of fitted?.claimIds ?? []) {
            const c = claimById.get(id);
            if (c === undefined) continue;
            console.log(`      [${c.type}] ${c.text}`);
            for (const q of c.quotes ?? []) console.log(`        "${q.text}" (${q.sourceId})`);
        }
    }
    for (const x of alloc.uninvested) console.log(`  uninvested ${formatUsdc(x.amount)} USDC: ${x.reason} (${x.theme ?? "no theme"})`);
    if (alloc.legs.length === 0) throw new Error("Nothing to propose");

    // Legs stay per theme for the mandate checks and the ledger. The swap plan is how the money would
    // actually be spent onchain: one swap per token, so gas is paid once per token rather than once per theme.
    const terms = mandates.current().terms;
    const plan = swapPlan(alloc.legs, terms.maxTradeUsdc);
    const legTotal = alloc.legs.reduce((a, l) => a + l.usdcIn, 0n);
    if (swapPlanTotal(plan) !== legTotal) throw new Error("swap plan does not spend what the legs spend");
    console.log(`\nSwap plan: ${plan.length} swaps for ${alloc.legs.length} legs (gas is paid per swap)`);
    for (const line of describeSwapPlan(plan)) console.log(`  ${line}`);

    console.log("\nGetting real quotes from KyberSwap (read-only)...");
    const q1 = await quoteLegs(alloc.legs, decimals, { slippageBps: SLIPPAGE_BPS });
    for (const [asset, why] of q1.errors) console.log(`  no quote for ${symbolOf.get(asset) ?? asset}: ${why}`);

    const created = tr.createProposal({ id: "live-1", legs: alloc.legs, quotedPrices: q1.prices });
    console.log(created.ok ? "Proposal accepted by the policy engine." : `Proposal refused: ${created.reasons.join(" | ")}`);
    if (!created.ok) process.exit(1);
    tr.approve("live-1", "owner");

    console.log("Waiting 3 seconds, then re-quoting (this is what the pre-execution check uses)...");
    await sleep(3000);
    const q2 = await quoteLegs(alloc.legs, decimals, { slippageBps: SLIPPAGE_BPS });
    const now = new Date();
    const tokenMap = new Map(check.trusted.map((t) => [t.address, t]));
    const gates = preTradeChecks({
        legs: alloc.legs,
        quotes: q2.quotes,
        tokens: tokenMap,
        liquidity: liquidity.scores,
        now,
    });
    const blocks = blockReasons(gates);
    const warns = warnings(gates);
    console.log(`Pre-trade gates: ${gates.filter((g) => g.level === "ok").length} ok, ${warns.length} warnings, ${blocks.length} blocks`);
    for (const w of warns) console.log(`  warning: ${w}`);
    for (const b of blocks) console.log(`  BLOCK: ${b}`);

    const result = tr.execute("live-1", { freshPrices: q2.prices, decimals, blocks });
    console.log(result.ok ? "Executed (SIMULATED fills at real quoted prices)." : `Stopped: ${result.reasons.join(" | ")}`);

    console.log("\nPrice check: quote vs the token list's NAV (reference only)");
    const rows = alloc.legs.map((l) => {
        const t = bySymbol.get(l.symbol)!;
        const p1 = q1.prices.get(l.asset);
        const p2 = q2.prices.get(l.asset);
        const quote = q2.quotes.get(l.asset);
        const px = p2 !== undefined ? Number(p2) / 1e6 : null;
        const out = quote?.amountOutUsd ?? null;
        const inn = quote?.amountInUsd ?? null;
        return {
            symbol: l.symbol,
            quotePx: px?.toFixed(2),
            nav: t.navPrice?.toFixed(2),
            vsNavPct: px !== null && t.navPrice ? (((px / t.navPrice) - 1) * 100).toFixed(2) : "n/a",
            navStatus: navStatus(t, now, 3600),
            quoteDriftBps: p1 !== undefined && p2 !== undefined ? Number(driftBps(p1, p2)) : "n/a",
            costBps: out !== null && inn ? Math.round((1 - out / inn) * 10_000) : "n/a",
            gasUsd: quote?.gasUsd?.toFixed(4),
        };
    });
    console.table(rows);

    console.log("Ledger");
    console.table(
        tr.ledger.all().map((x) => ({
            id: x.id, type: x.type, mode: x.mode, memo: (x.memo ?? "").slice(0, 60),
        })),
    );
    console.log("Reconcile:", reconcileInternal(tr.ledger));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});