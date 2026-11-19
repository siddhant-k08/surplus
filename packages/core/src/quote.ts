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