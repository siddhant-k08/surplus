import { BASE_USDC } from "./liquidity";

/** KyberSwap router on Base, as published in Base's agent docs. Anything else is refused. */
export const KYBER_ROUTER_BASE = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";

export const KYBER_ROUTES_URL = "https://aggregator-api.kyberswap.com/base/api/v1/routes";

export interface Quote {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint; // USDC minor units
    amountOut: bigint; // token minor units
    amountInUsd: number | null;
    amountOutUsd: number | null;
    gasUsd: number | null;
    l1FeeUsd: number | null;
    routerAddress: string;
    routeId: string | null;
    timestamp: number | null; // unix seconds (assumed to be route creation time)
    routeSummary: unknown; // kept verbatim: the build step needs it unchanged
}

export interface QuoteExpectation {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    router?: string;
}

function big(v: unknown): bigint | null {
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    return null;
}

function numOrNull(v: unknown): number | null {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function lower(v: unknown): string {
    return typeof v === "string" ? v.toLowerCase() : "";
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function routesUrl(i: {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    slippageBps: number;
    source?: string;
}): string {
    const url = new URL(KYBER_ROUTES_URL);
    url.searchParams.set("tokenIn", i.tokenIn);
    url.searchParams.set("tokenOut", i.tokenOut);
    url.searchParams.set("amountIn", i.amountIn.toString());
    url.searchParams.set("slippageTolerance", String(i.slippageBps));
    url.searchParams.set("source", i.source ?? "surplus-hackathon");
    return url.toString();
}

/** Validates a route response against what we asked for. Throws on anything unexpected. */
export function parseKyberRoute(json: unknown, exp: QuoteExpectation): Quote {
    if (!isObject(json)) throw new Error("Route response is not an object");
    const data = json.data;
    if (!isObject(data) || !isObject(data.routeSummary)) {
        throw new Error(`Route request failed: code ${String(json.code)}, message "${String(json.message)}"`);
    }
    const rs = data.routeSummary;

    if (lower(rs.tokenIn) !== exp.tokenIn.toLowerCase()) throw new Error("Route tokenIn does not match the request");
    if (lower(rs.tokenOut) !== exp.tokenOut.toLowerCase()) throw new Error("Route tokenOut does not match the request");

    const amountIn = big(rs.amountIn);
    if (amountIn === null || amountIn !== exp.amountIn) throw new Error("Route amountIn does not match the request");
    const amountOut = big(rs.amountOut);
    if (amountOut === null || amountOut <= 0n) throw new Error("Route amountOut is missing or zero");

    const pinned = (exp.router ?? KYBER_ROUTER_BASE).toLowerCase();
    const routerAddress = lower(data.routerAddress);
    if (routerAddress !== pinned) throw new Error(`Unexpected router ${routerAddress || "(missing)"}`);
    if (rs.routerAddress !== undefined && lower(rs.routerAddress) !== pinned) {
        throw new Error(`Unexpected router in routeSummary ${lower(rs.routerAddress)}`);
    }

    let timestamp = numOrNull(rs.timestamp);
    if (timestamp !== null && timestamp > 1e12) timestamp = Math.floor(timestamp / 1000);

    return {
        tokenIn: lower(rs.tokenIn),
        tokenOut: lower(rs.tokenOut),
        amountIn,
        amountOut,
        amountInUsd: numOrNull(rs.amountInUsd),
        amountOutUsd: numOrNull(rs.amountOutUsd),
        gasUsd: numOrNull(rs.gasUsd),
        l1FeeUsd: numOrNull(rs.l1FeeUsd),
        routerAddress,
        routeId: typeof rs.routeID === "string" ? rs.routeID : null,
        timestamp,
        routeSummary: rs,
    };
}

/** USDC minor units per one whole token, from the quote itself. Matches the approval PriceMap unit. */
export function priceOf(q: Quote, tokenDecimals: number): bigint {
    return (q.amountIn * 10n ** BigInt(tokenDecimals)) / q.amountOut;
}

/**
 * The same price from a quote that goes the other way.
 *
 * On a sale the token is what goes in and USDC is what comes out, so the ratio inverts. Reusing
 * `priceOf` on a sale quote would return tokens per USDC and call it a price, which would be wrong by
 * many orders of magnitude and wrong in the direction that looks like an enormous profit.
 */
export function priceOfSale(q: Quote, tokenDecimals: number): bigint {
    return (q.amountOut * 10n ** BigInt(tokenDecimals)) / q.amountIn;
}

/** Routes expire in about 30 seconds per the docs, so the default window is shorter. */
export function isQuoteFresh(q: Quote, now: Date, maxAgeSeconds = 25): boolean {
    if (q.timestamp === null) return false;
    const age = now.getTime() / 1000 - q.timestamp;
    return age >= -5 && age <= maxAgeSeconds;
}

/** Smallest acceptable output for a given slippage tolerance, rounded down. */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
        throw new Error(`slippageBps must be an integer from 0 to 10000, got ${slippageBps}`);
    }
    return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Deadline for one outbound request.
 *
 * Without it an upstream that accepts a connection and never answers holds the caller forever: an owner
 * route, or worse a paid request that is holding a verified payment.
 */
export const HTTP_TIMEOUT_MS = 15_000;

/**
 * One route from the aggregator.
 *
 * `tokenIn` defaults to USDC, which is a buy. A sale passes the token as `tokenIn` and USDC as
 * `tokenOut`; `amountIn` is then token minor units rather than USDC, and the response is validated
 * against whichever pair was actually asked for.
 */
export async function fetchRoute(
    i: {
        tokenIn?: string;
        tokenOut: string;
        amountIn: bigint;
        slippageBps: number;
        usdc?: string;
        timeoutMs?: number;
    },
    fetchImpl: typeof fetch = fetch,
): Promise<Quote> {
    const tokenIn = i.tokenIn ?? i.usdc ?? BASE_USDC;
    const res = await fetchImpl(
        routesUrl({ tokenIn, tokenOut: i.tokenOut, amountIn: i.amountIn, slippageBps: i.slippageBps }),
        { signal: AbortSignal.timeout(i.timeoutMs ?? HTTP_TIMEOUT_MS) },
    );
    const body: unknown = await res.json().catch(() => null);
    if (body === null) throw new Error(`Route request failed: HTTP ${res.status}`);
    return parseKyberRoute(body, { tokenIn, tokenOut: i.tokenOut, amountIn: i.amountIn });
}

export interface LegRequest {
    asset: string;
    usdcIn: bigint;
    /** Absent for a buy. A sale is quoted the other way round, token in and USDC out. */
    side?: "sell";
    /** Sale only: the token units being disposed of, which is what the route is sized by. */
    unitsIn?: bigint;
}

export interface LegQuotes {
    prices: Map<string, bigint>; // asset -> USDC minor units per whole token
    quotes: Map<string, Quote>;
    errors: Map<string, string>; // asset -> why there is no usable quote
}

/**
 * One quote per distinct token, sized to that token's total spend and spaced out.
 * A failure for one token is recorded in `errors`; it never stops the others.
 *
 * A buy is sized in USDC and a sale in token units, but both come back as a price in the same unit, so
 * everything downstream compares like with like. The maps are keyed by token, so one call quotes one
 * direction per token: asking for both is refused rather than letting the second overwrite the first
 * and price a sale at what a buy would have cost.
 */
export async function quoteLegs(
    legs: readonly LegRequest[],
    decimals: ReadonlyMap<string, number>,
    opts: {
        slippageBps: number;
        fetchImpl?: typeof fetch;
        delayMs?: number;
        sleep?: (ms: number) => Promise<void>;
        usdc?: string;
        timeoutMs?: number;
    },
): Promise<LegQuotes> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const delay = opts.delayMs ?? 500;

    const usdc = opts.usdc ?? BASE_USDC;
    const totals = new Map<string, { amountIn: bigint; sell: boolean }>();
    for (const l of legs) {
        const key = l.asset.toLowerCase();
        const sell = l.side === "sell";
        const row = totals.get(key);
        if (row === undefined) {
            totals.set(key, { amountIn: sell ? (l.unitsIn ?? 0n) : l.usdcIn, sell });
            continue;
        }
        if (row.sell !== sell) {
            throw new Error(
                `legs for ${key} ask to buy and to sell at once; one call quotes one direction per token`,
            );
        }
        row.amountIn += sell ? (l.unitsIn ?? 0n) : l.usdcIn;
    }

    const out: LegQuotes = { prices: new Map(), quotes: new Map(), errors: new Map() };
    let first = true;
    for (const [asset, { amountIn, sell }] of totals) {
        const dec = decimals.get(asset);
        if (dec === undefined) {
            out.errors.set(asset, "missing decimals");
            continue;
        }
        if (amountIn <= 0n) {
            out.errors.set(asset, sell ? "no units to sell" : "nothing to spend");
            continue;
        }
        if (!first && delay > 0) await sleep(delay);
        first = false;
        try {
            const q = await fetchRoute(
                {
                    ...(sell ? { tokenIn: asset, tokenOut: usdc } : { tokenOut: asset }),
                    amountIn,
                    slippageBps: opts.slippageBps,
                    ...(opts.usdc !== undefined && { usdc: opts.usdc }),
                    ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
                },
                opts.fetchImpl,
            );
            out.quotes.set(asset, q);
            out.prices.set(asset, sell ? priceOfSale(q, dec) : priceOf(q, dec));
        } catch (e) {
            out.errors.set(asset, e instanceof Error ? e.message : String(e));
        }
    }
    return out;
}