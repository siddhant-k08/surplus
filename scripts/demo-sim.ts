import {
    MandateStore,
    Treasury,
    BASE_REGISTRY,
    allocate,
    parseUsdc as u,
    formatUsdc,
    reconcileInternal,
    type Leg,
} from "../packages/core/src/index";

const addr = (symbol: string): string => BASE_REGISTRY.find((r) => r.symbol === symbol)!.address;
const NVDA = addr("NVDAc");
const MSFT = addr("MSFTc");
const META = addr("METAc");
const AMZN = addr("AMZNc");

// Illustrative prices (USDC minor units per whole token) and an assumed 18 decimals.
const quoted = new Map([[NVDA, 153_690_000n], [MSFT, 514_870_000n], [META, 625_560_000n], [AMZN, 273_780_000n]]);
const decimals = new Map([[NVDA, 18], [MSFT, 18], [META, 18], [AMZN, 18]]);

let t = Date.parse("2026-11-19T12:00:00Z");
const now = () => new Date(t);
const tick = (s: number) => { t += s * 1000; };

const mandates = new MandateStore();
mandates.create(
    {
        eligible: [NVDA, MSFT, META, AMZN],
        themes: [
            { id: "ai-compute", targetBps: 5000 },
            { id: "platform-giants", targetBps: 3000 },
            { id: "longevity-biotech", targetBps: 2000 },
        ],
        maxCompanyBps: 4000,
        investShareBps: 5000,
        maxTradeUsdc: u("1.00"),
        minTradeUsdc: u("0.10"),
        reserveTargetUsdc: u("2.00"),
        maxSlippageBps: 100,
        driftToleranceBps: 100,
        approvalExpirySeconds: 600,
    },
    now(),
);

const tr = new Treasury({ mode: "sim", mandates, now });
tr.ledger.post({
    type: "OPENING_BALANCE", mode: "sim", at: now(), memo: "opening reserve",
    lines: [{ account: "reserve", amount: u("1.50") }, { account: "equity.opening", amount: u("-1.50") }],
});

console.log("== 1. Paid research request, costs, reserve, surplus (SIMULATED) ==");
tr.receivePayment({ id: "pay-1", briefId: "brief-1", amount: u("3.00") });
tr.accrueCost({ id: "c-llm", briefId: "brief-1", kind: "llm", amount: u("0.50"), memo: "metered estimate" });
tr.accrueCost({ id: "c-search", briefId: "brief-1", kind: "search", amount: u("0.10"), memo: "metered estimate" });
const s = tr.settleBrief("brief-1");
console.log(`net ${formatUsdc(s.net)}, reserve top-up ${formatUsdc(s.reserveTopUp)}, surplus ${formatUsdc(s.surplus)}, investable ${formatUsdc(s.investable)}`);

console.log("\n== 2. Proposal from the allocator ==");
const alloc = allocate({
    investable: tr.ledger.balance("surplus.investable"),
    terms: mandates.current().terms,
    themes: [
        { id: "ai-compute", candidates: [{ asset: NVDA, symbol: "NVDAc", weight: 60 }, { asset: MSFT, symbol: "MSFTc", weight: 40 }] },
        { id: "platform-giants", candidates: [{ asset: META, symbol: "METAc", weight: 145 }, { asset: AMZN, symbol: "AMZNc", weight: 140 }] },
    ],
});
for (const l of alloc.legs) console.log(`  ${l.symbol.padEnd(7)} ${formatUsdc(l.usdcIn)} USDC (${l.theme})`);
for (const x of alloc.uninvested) console.log(`  uninvested ${formatUsdc(x.amount)} USDC: ${x.reason} (${x.theme ?? "no theme"})`);

console.log("\n== 3. A rule-breaking edit is refused ==");
const bad: Leg[] = [{ asset: NVDA, symbol: "NVDAc", theme: "ai-compute", usdcIn: u("0.60"), maxSlippageBps: 100 }];
const refused = tr.createProposal({ id: "edited", legs: bad, quotedPrices: quoted });
console.log(refused.ok ? "unexpectedly accepted" : `refused: ${refused.reasons.join(" | ")}`);

console.log("\n== 4. Valid proposal, approval, then the price moves ==");
tr.createProposal({ id: "pr-1", legs: alloc.legs, quotedPrices: quoted });
tick(20);
tr.approve("pr-1", "owner");
tick(20);
const moved = new Map(quoted).set(NVDA, 156_760_000n);
const stopped = tr.execute("pr-1", { freshPrices: moved, decimals });
console.log(stopped.ok ? "executed" : `stopped: ${stopped.reasons.join(" | ")}`);

console.log("\n== 5. Re-propose, approve again, execute (SIMULATED) ==");
tr.repropose("pr-1", moved);
tick(20);
tr.approve("pr-1", "owner");
tick(20);
const done = tr.execute("pr-1", { freshPrices: moved, decimals });
console.log(done.ok ? `settled ${done.fills.length} fills` : `stopped: ${done.reasons.join(" | ")}`);

console.log("\n== Ledger ==");
console.table(
    tr.ledger.all().map((x) => ({
        id: x.id,
        time: x.at.slice(11, 19),
        type: x.type,
        mode: x.mode,
        memo: (x.memo ?? "").slice(0, 70),
    })),
);

console.log("== Balances (USDC) ==");
const rows: Record<string, string> = {};
for (const [account, v] of tr.ledger.balances()) rows[account] = formatUsdc(v);
console.table(rows);
console.log("Reconcile:", reconcileInternal(tr.ledger));