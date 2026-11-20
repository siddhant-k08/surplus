import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    loadAllTokens,
    crossCheck,
    loadLiquidityScores,
    toCandidates,
    validateBrief,
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
    type Brief,
    type Claim,
    type ThemeInput,
} from "../packages/core/src/index";

const SLIPPAGE_BPS = 100;
const BRIEFS_DIR = "docs/briefs";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SavedBrief {
    file: string;
    provider: string;
    model: string;
    brief: Brief;
    costUsdcMinor: bigint;
    costUsd: number;
}

/**
 * Reads the newest brief written by demo-research.ts. The saved file holds the brief plus the metered model
 * cost; the cost is stored as a decimal string of USDC minor units so it survives JSON without a float.
 */
function loadLatestBrief(): SavedBrief {
    const files = readdirSync(BRIEFS_DIR).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
        throw new Error(`No briefs in ${BRIEFS_DIR}. Run "npx tsx scripts/demo-research.ts" first.`);
    }
    const saved = files.map((file) => {
        const raw: unknown = JSON.parse(readFileSync(join(BRIEFS_DIR, file), "utf8"));
        if (typeof raw !== "object" || raw === null) throw new Error(`${file} is not an object`);
        const r = raw as Record<string, unknown>;
        const brief = r.brief as Brief | undefined;
        if (brief === undefined || typeof brief.id !== "string" || !Array.isArray(brief.themes)) {
            throw new Error(`${file} has no usable brief`);
        }
        if (typeof r.costUsdcMinor !== "string" || !/^\d+$/.test(r.costUsdcMinor)) {
            throw new Error(`${file} has no costUsdcMinor`);
        }
        return {
            file,
            provider: typeof r.provider === "string" ? r.provider : "unknown",
            model: typeof r.model === "string" ? r.model : "unknown",
            brief,
            costUsdcMinor: BigInt(r.costUsdcMinor),
            costUsd: typeof r.costUsd === "number" ? r.costUsd : 0,
        };
    });
    saved.sort((a, b) => Date.parse(b.brief.createdAt) - Date.parse(a.brief.createdAt));
    return saved[0]!;
}

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

    const saved = loadLatestBrief();
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

    const tr = new Treasury({ mode: "sim", mandates });
    tr.ledger.post({
        type: "OPENING_BALANCE", mode: "sim", memo: "opening reserve (simulated)",
        lines: [{ account: "reserve", amount: u("1.50") }, { account: "equity.opening", amount: u("-1.50") }],
    });
    // The sale price is simulated; the model cost is the real metered cost of the brief above.
    tr.receivePayment({ id: `pay-${brief.id}`, briefId: brief.id, amount: u("3.00") });
    tr.accrueCost({
        id: `llm-${brief.id}`,
        briefId: brief.id,
        kind: "llm",
        amount: saved.costUsdcMinor,
        memo: "metered estimate at paid-tier rates",
    });
    const s = tr.settleBrief(brief.id);
    console.log(
        `\nRevenue ${formatUsdc(u("3.00"))} (SIMULATED sale), real model cost ${formatUsdc(saved.costUsdcMinor)}, ` +
        `surplus ${formatUsdc(s.surplus)}, investable ${formatUsdc(s.investable)}`,
    );

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