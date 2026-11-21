import { KYBER_ROUTER_BASE, HTTP_TIMEOUT_MS, type Quote } from "./quote";

/**
 * Turning a quote into a transaction.
 *
 * The aggregator quotes a route and then encodes it separately: the `routeSummary` from the quote is
 * posted back untouched and comes back as calldata. Keeping these two steps apart is what lets the agent
 * quote, show the owner what it will do, take a signature, re-quote and only then encode.
 *
 * Shape verified against KyberSwap's EVM swap API specification on 21 Nov 2026:
 * POST /{chain}/api/v1/route/build with routeSummary, sender, recipient, slippageTolerance, deadline
 * and source; the response carries data, routerAddress, amountIn, amountOut and gas.
 */

export const KYBER_BUILD_URL = "https://aggregator-api.kyberswap.com/base/api/v1/route/build";
export const CLIENT_ID = "surplus-hackathon";

export interface BuiltSwap {
    /** Calldata for the router. */
    data: `0x${string}`;
    router: `0x${string}`;
    amountIn: bigint;
    /** What the route expects out. The minimum actually enforced is `minOut`. */
    amountOut: bigint;
    /** Floor the router will revert below, derived from the slippage the owner agreed to. */
    minOut: bigint;
    gas: bigint | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const big = (v: unknown): bigint | null => {
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
    return null;
};

/**
 * Validates an encoded route before it can become a transaction.
 *
 * Everything here is a refusal rather than a repair. This is the last point at which the agent can
 * notice that what came back is not what it asked for, and after this the bytes are signed and sent.
 */
export function parseBuiltSwap(
    json: unknown,
    expect: { amountIn: bigint; minOut: bigint; router?: string },
): BuiltSwap {
    if (!isObj(json)) throw new Error("Build response is not an object");
    const data = isObj(json.data) ? json.data : json;
    if (!isObj(data)) throw new Error("Build response has no data");

    const calldata = data.data;
    if (typeof calldata !== "string" || !/^0x[0-9a-fA-F]+$/.test(calldata) || calldata.length < 10) {
        throw new Error("Build response carries no usable calldata");
    }

    const router = typeof data.routerAddress === "string" ? data.routerAddress.toLowerCase() : "";
    const pinned = (expect.router ?? KYBER_ROUTER_BASE).toLowerCase();
    if (router !== pinned) throw new Error(`Build returned router ${router || "(missing)"}, expected ${pinned}`);

    const amountIn = big(data.amountIn);
    if (amountIn === null) throw new Error("Build response has no amountIn");
    if (amountIn !== expect.amountIn) {
        // the encoded spend must be exactly what was quoted and approved, never more
        throw new Error(`Build would spend ${amountIn}, but ${expect.amountIn} was quoted`);
    }

    const amountOut = big(data.amountOut);
    if (amountOut === null) throw new Error("Build response has no amountOut");
    if (amountOut < expect.minOut) {
        throw new Error(`Build expects ${amountOut} out, below the agreed floor of ${expect.minOut}`);
    }

    return {
        data: calldata as `0x${string}`,
        router: pinned as `0x${string}`,
        amountIn,
        amountOut,
        minOut: expect.minOut,
        gas: big(data.gas),
    };
}

export interface BuildRequest {
    quote: Quote;
    /** The wallet that holds the USDC and will send the transaction. */
    sender: string;
    /** Where the bought tokens land. Usually the sender. */
    recipient: string;
    slippageBps: number;
    minOut: bigint;
    deadlineSeconds?: number;
    now?: () => number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/** Encodes a quoted route into calldata, ready to send. */
export async function buildSwap(i: BuildRequest): Promise<BuiltSwap> {
    const now = i.now ?? (() => Date.now());
    const deadline = Math.floor(now() / 1000) + (i.deadlineSeconds ?? 120);
    const fetchImpl = i.fetchImpl ?? fetch;

    const res = await fetchImpl(KYBER_BUILD_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-id": CLIENT_ID },
        signal: AbortSignal.timeout(i.timeoutMs ?? HTTP_TIMEOUT_MS),
        body: JSON.stringify({
            // posted back exactly as the quote returned it; the encoder rejects anything it did not produce
            routeSummary: i.quote.routeSummary,
            sender: i.sender,
            recipient: i.recipient,
            slippageTolerance: i.slippageBps,
            deadline,
            source: CLIENT_ID,
        }),
    });

    const body: unknown = await res.json().catch(() => null);
    if (body === null) throw new Error(`Build request failed: HTTP ${res.status}`);
    if (!res.ok) {
        const message = isObj(body) && typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
        throw new Error(`Build request failed: ${message}`);
    }
    return parseBuiltSwap(body, { amountIn: i.quote.amountIn, minOut: i.minOut });
}
