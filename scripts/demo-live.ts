import {
    loadAllTokens,
    crossCheck,
    loadLiquidityScores,
    toCandidates,
    allocate,
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
    type Fit,
    type ThemeInput,
} from "../packages/core/src/index";

const SLIPPAGE_BPS = 100;
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
    const addrOf = (symbol: string): string => {
        const t = bySymbol.get(symbol);
        if (!t) throw new Error(`${symbol} is not a trusted token right now`);
        return t.address;
    };

    console.log("Loading pool liquidity (one request per token, spaced out)...");
    const liquidity = await loadLiquidityScores(check.trusted.map((t) => t.address));

    // DEMO PLACEHOLDERS: these scores are made up to drive the demo. They are not research.
    const fit = (symbol: string, f: number, e: number): Fit => ({
        asset: addrOf(symbol), symbol, fit: f, evidence: e, claimIds: [],
    });
    const fits: Record<string, Fit[]> = {
        "ai-compute": [fit("NVDAc", 5, 4), fit("MSFTc", 4, 4), fit("GOOGLc", 4, 3)],
        "platform-giants": [fit("METAc", 4, 4), fit("AMZNc", 4, 3), fit("AAPLc", 4, 4)],
    };
    const themes: ThemeInput[] = Object.entries(fits).map(([id, f]) => ({
        id,
        candidates: toCandidates(f, liquidity.scores, 3, 1),
    }));

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

    const tr = new Treasury({ mode: "sim", mandates });
    tr.ledger.post({
        type: "OPENING_BALANCE", mode: "sim", memo: "opening reserve (simulated)",
        lines: [{ account: "reserve", amount: u("1.50") }, { account: "equity.opening", amount: u("-1.50") }],
    });
    tr.receivePayment({ id: "pay-1", briefId: "brief-1", amount: u("3.00") });
    tr.accrueCost({ id: "c-llm", briefId: "brief-1", kind: "llm", amount: u("0.50"), memo: "metered estimate" });
    tr.accrueCost({ id: "c-search", briefId: "brief-1", kind: "search", amount: u("0.10"), memo: "metered estimate" });
    const s = tr.settleBrief("brief-1");
    console.log(`\nSimulated surplus: ${formatUsdc(s.surplus)}, investable ${formatUsdc(s.investable)}`);

    const alloc = allocate({ investable: tr.ledger.balance("surplus.investable"), themes, terms: mandates.current().terms });
    console.log("\nProposed legs (fits are demo placeholders, not research):");
    for (const l of alloc.legs) console.log(`  ${l.symbol.padEnd(7)} ${formatUsdc(l.usdcIn)} USDC (${l.theme})`);
    for (const x of alloc.uninvested) console.log(`  uninvested ${formatUsdc(x.amount)} USDC: ${x.reason} (${x.theme ?? "no theme"})`);
    if (alloc.legs.length === 0) throw new Error("Nothing to propose");

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