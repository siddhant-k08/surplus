/** Native USDC on Base mainnet, per Circle's published address. */
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export interface Pair {
    dexId: string;
    pairAddress: string;
    labels: string[];
    base: string; // lowercase token addresses
    quote: string;
    baseSymbol: string;
    quoteSymbol: string;
    priceUsd: number | null; // USD price of the BASE token
    liquidityUsd: number;
    volumeH24Usd: number | null;
}

function numOrNull(v: unknown): number | null {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

/** Parses a DexScreener pairs response. Keeps only valid Base pairs; other records are dropped. */
export function parsePairs(json: unknown): Pair[] {
    const list: unknown = Array.isArray(json)
        ? json
        : typeof json === "object" && json !== null
            ? (json as Record<string, unknown>).pairs
            : undefined;
    if (!Array.isArray(list)) throw new Error("Pairs response is not an array");

    const out: Pair[] = [];
    for (const raw of list as unknown[]) {
        if (typeof raw !== "object" || raw === null) continue;
        const p = raw as Record<string, unknown>;
        if (p.chainId !== "base") continue;
        const base = p.baseToken as Record<string, unknown> | undefined;
        const quote = p.quoteToken as Record<string, unknown> | undefined;
        const baseAddr = str(base?.address).toLowerCase();
        const quoteAddr = str(quote?.address).toLowerCase();
        const pairAddress = str(p.pairAddress);
        if (!baseAddr || !quoteAddr || !pairAddress) continue;
        const liquidity = p.liquidity as Record<string, unknown> | undefined;
        const volume = p.volume as Record<string, unknown> | undefined;
        out.push({
            dexId: str(p.dexId),
            pairAddress,
            labels: Array.isArray(p.labels) ? p.labels.filter((x): x is string => typeof x === "string") : [],
            base: baseAddr,
            quote: quoteAddr,
            baseSymbol: str(base?.symbol),
            quoteSymbol: str(quote?.symbol),
            priceUsd: numOrNull(p.priceUsd),
            liquidityUsd: Math.max(0, numOrNull(liquidity?.usd) ?? 0),
            volumeH24Usd: numOrNull(volume?.h24),
        });
    }
    return out;
}

export interface PoolSummary {
    dexId: string;
    pairAddress: string;
    labels: string[];
    liquidityUsd: number;
    volumeH24Usd: number | null;
    tokenPriceUsd: number | null;
}

/** USDC pools for one token, matched on exact addresses only, most liquid first. */
export function usdcPools(
    pairs: readonly Pair[],
    token: string,
    usdc: string = BASE_USDC,
): PoolSummary[] {
    const t = token.toLowerCase();
    const u = usdc.toLowerCase();
    return pairs
        .filter((p) => (p.base === t && p.quote === u) || (p.base === u && p.quote === t))
        .map((p) => ({
            dexId: p.dexId,
            pairAddress: p.pairAddress,
            labels: p.labels,
            liquidityUsd: p.liquidityUsd,
            volumeH24Usd: p.volumeH24Usd,
            tokenPriceUsd: p.base === t ? p.priceUsd : null,
        }))
        .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

/** 0 to 5 liquidity score from the single deepest pool. Thresholds are a recommendation, not a fact. */
export function liquidityScore(usd: number): number {
    if (!Number.isFinite(usd) || usd < 25_000) return 0;
    if (usd < 100_000) return 1;
    if (usd < 250_000) return 2;
    if (usd < 500_000) return 3;
    if (usd < 1_000_000) return 4;
    return 5;
}

export function liquidityScores(
    pairs: readonly Pair[],
    tokens: readonly string[],
    usdc: string = BASE_USDC,
): Map<string, number> {
    const out = new Map<string, number>();
    for (const token of tokens) {
        const best = usdcPools(pairs, token, usdc)[0];
        out.set(token.toLowerCase(), liquidityScore(best?.liquidityUsd ?? 0));
    }
    return out;
}