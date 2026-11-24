import { formatUsdc, mulBps } from "./money";
import type { MandateTerms } from "./mandate";

export interface Leg {
    readonly asset: string;
    readonly symbol: string;
    readonly theme: string;
    /**
     * The USDC notional of this leg: what a buy spends, what a sale is quoted to return.
     *
     * One field for both directions so every size rule the mandate states (min trade, max trade, the
     * signed ceiling) means the same thing whichever way the trade goes.
     */
    readonly usdcIn: bigint;
    readonly maxSlippageBps: number;
    /**
     * Absent for a buy, on purpose.
     *
     * `canonicalJson` drops undefined keys, so every proposal written before the sell path existed
     * hashes exactly as it did before, and an approval signed against one still verifies.
     */
    readonly side?: "sell";
    /** Sell only: the token units to dispose of. The hash binds it, so the owner signs an exact size. */
    readonly unitsIn?: bigint;
}

export const isSell = (l: Leg): boolean => l.side === "sell";

export interface Proposal {
    readonly investable: bigint;
    readonly legs: readonly Leg[];
    /** Already-held exposure per asset, counted toward the company cap. */
    readonly held?: ReadonlyMap<string, bigint>;
    /** Token units held per asset, which is what a sale may not exceed. */
    readonly heldUnits?: ReadonlyMap<string, bigint>;
}

export interface PolicyResult {
    readonly rule: string;
    readonly ok: boolean;
    readonly detail: string;
}

const pass = (rule: string): PolicyResult => ({ rule, ok: true, detail: "ok" });
const fail = (rule: string, offenders: string[]): PolicyResult => ({
    rule,
    ok: false,
    detail: offenders.join("; "),
});
const result = (rule: string, offenders: string[]): PolicyResult =>
    offenders.length === 0 ? pass(rule) : fail(rule, offenders);

function totalsBy(legs: readonly Leg[], key: (l: Leg) => string): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const l of legs) m.set(key(l), (m.get(key(l)) ?? 0n) + l.usdcIn);
    return m;
}

/**
 * Checks one proposal against the mandate.
 *
 * Several rules are buy-side only, and which ones is a judgement rather than an oversight. The caps on
 * exposure (the company cap, the theme targets, the investable total) exist to limit how much the agent
 * puts at risk; a sale reduces every one of them, so applying them to a sale would be a rule that stops
 * the agent reducing risk. The eligible list is the sharpest case: it says what may be *bought*. An
 * owner who removes a token from it has to be able to sell what is already held, or the list becomes a
 * trap that locks the agent into exactly the position the owner just decided against.
 */
export function checkProposal(p: Proposal, t: MandateTerms): PolicyResult[] {
    const eligible = new Set(t.eligible.map((a) => a.toLowerCase()));
    const symbols = new Map(p.legs.map((l) => [l.asset.toLowerCase(), l.symbol]));
    const results: PolicyResult[] = [];
    const buys = p.legs.filter((l) => !isSell(l));
    const sells = p.legs.filter(isSell);

    results.push(
        result(
            "positiveAmounts",
            p.legs
                .filter((l) => l.usdcIn <= 0n)
                .map((l) => `${l.symbol} amount ${formatUsdc(l.usdcIn)} is not positive`),
        ),
    );

    results.push(
        result(
            "eligibleOnly",
            buys
                .filter((l) => !eligible.has(l.asset.toLowerCase()))
                .map((l) => `${l.symbol} (${l.asset}) is not on the eligible list`),
        ),
    );

    results.push(
        result(
            "minTrade",
            p.legs
                .filter((l) => l.usdcIn < t.minTradeUsdc)
                .map((l) => `${l.symbol} ${formatUsdc(l.usdcIn)} is below minimum ${formatUsdc(t.minTradeUsdc)}`),
        ),
    );

    results.push(
        result(
            "maxTrade",
            p.legs
                .filter((l) => l.usdcIn > t.maxTradeUsdc)
                .map((l) => `${l.symbol} ${formatUsdc(l.usdcIn)} exceeds max trade ${formatUsdc(t.maxTradeUsdc)}`),
        ),
    );

    // A sale must be of units the agent actually holds. Without this the books could go short, which
    // `reconcileInternal` would then report as a negative position long after the swap had gone out.
    const heldUnits = p.heldUnits ?? new Map<string, bigint>();
    const unitsWanted = new Map<string, bigint>();
    for (const l of sells) {
        const key = l.asset.toLowerCase();
        unitsWanted.set(key, (unitsWanted.get(key) ?? 0n) + (l.unitsIn ?? 0n));
    }
    const sellOffenders: string[] = [];
    for (const l of sells) {
        if (l.unitsIn === undefined || l.unitsIn <= 0n) {
            sellOffenders.push(`${l.symbol} is a sale with no positive unit amount`);
        }
    }
    for (const [asset, wanted] of unitsWanted) {
        const have = heldUnits.get(asset) ?? 0n;
        if (wanted > have) {
            sellOffenders.push(`${symbols.get(asset) ?? asset} would sell ${wanted} units but only ${have} are held`);
        }
    }
    results.push(result("sellOnlyWhatIsHeld", sellOffenders));

    const held = p.held ?? new Map<string, bigint>();
    const heldTotal = [...held.values()].reduce((a, v) => a + v, 0n);
    const companyCap = mulBps(p.investable + heldTotal, t.maxCompanyBps);
    results.push(
        result(
            "maxCompany",
            [...totalsBy(buys, (l) => l.asset.toLowerCase())]
                .map(([asset, total]) => [asset, total + (held.get(asset) ?? 0n)] as const)
                .filter(([, total]) => total > companyCap)
                .map(
                    ([asset, total]) =>
                        `${symbols.get(asset) ?? asset} ${formatUsdc(total)} exceeds company cap ${formatUsdc(companyCap)}`,
                ),
        ),
    );

    const themeOffenders: string[] = [];
    for (const [theme, total] of totalsBy(buys, (l) => l.theme)) {
        const target = t.themes.find((x) => x.id === theme);
        if (!target) {
            themeOffenders.push(`theme "${theme}" is not in the mandate`);
            continue;
        }
        const cap = mulBps(p.investable, target.targetBps);
        if (total > cap) {
            themeOffenders.push(`theme "${theme}" ${formatUsdc(total)} exceeds target cap ${formatUsdc(cap)}`);
        }
    }
    results.push(result("themeTargets", themeOffenders));

    // Only what is spent has to be covered. Proceeds from a sale arrive as part of the same execution,
    // but counting them here would let a proposal fund a buy out of a sale that has not happened yet.
    const spend = buys.reduce((a, l) => a + l.usdcIn, 0n);
    results.push(
        result(
            "totalWithinInvestable",
            spend > p.investable
                ? [`total ${formatUsdc(spend)} exceeds investable ${formatUsdc(p.investable)}`]
                : [],
        ),
    );

    results.push(
        result(
            "slippage",
            p.legs
                .filter((l) => l.maxSlippageBps > t.maxSlippageBps)
                .map((l) => `${l.symbol} slippage ${l.maxSlippageBps} bps exceeds ${t.maxSlippageBps} bps`),
        ),
    );

    return results;
}

export const allPass = (rs: readonly PolicyResult[]): boolean => rs.every((r) => r.ok);
export const failures = (rs: readonly PolicyResult[]): PolicyResult[] => rs.filter((r) => !r.ok);