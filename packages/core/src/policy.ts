import { formatUsdc, mulBps } from "./money";
import type { MandateTerms } from "./mandate";

export interface Leg {
    readonly asset: string;
    readonly symbol: string;
    readonly theme: string;
    readonly usdcIn: bigint;
    readonly maxSlippageBps: number;
}

export interface Proposal {
    readonly investable: bigint;
    readonly legs: readonly Leg[];
    /** Already-held exposure per asset, counted toward the company cap. */
    readonly held?: ReadonlyMap<string, bigint>;
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

export function checkProposal(p: Proposal, t: MandateTerms): PolicyResult[] {
    const eligible = new Set(t.eligible.map((a) => a.toLowerCase()));
    const symbols = new Map(p.legs.map((l) => [l.asset.toLowerCase(), l.symbol]));
    const results: PolicyResult[] = [];

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
            p.legs
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

    const held = p.held ?? new Map<string, bigint>();
    const heldTotal = [...held.values()].reduce((a, v) => a + v, 0n);
    const companyCap = mulBps(p.investable + heldTotal, t.maxCompanyBps);
    results.push(
        result(
            "maxCompany",
            [...totalsBy(p.legs, (l) => l.asset.toLowerCase())]
                .map(([asset, total]) => [asset, total + (held.get(asset) ?? 0n)] as const)
                .filter(([, total]) => total > companyCap)
                .map(
                    ([asset, total]) =>
                        `${symbols.get(asset) ?? asset} ${formatUsdc(total)} exceeds company cap ${formatUsdc(companyCap)}`,
                ),
        ),
    );

    const themeOffenders: string[] = [];
    for (const [theme, total] of totalsBy(p.legs, (l) => l.theme)) {
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

    const total = p.legs.reduce((a, l) => a + l.usdcIn, 0n);
    results.push(
        result(
            "totalWithinInvestable",
            total > p.investable
                ? [`total ${formatUsdc(total)} exceeds investable ${formatUsdc(p.investable)}`]
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