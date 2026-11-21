/**
 * Everything the desk asks the agent.
 *
 * Nothing here imports `@surplus/core` at runtime: that package reaches for `node:fs` and `node:crypto`,
 * so pulling it into the browser bundle would break the build. Types are imported with `import type`,
 * which is erased, and the handful of money helpers the desk needs are local.
 */

/** USDC minor units as a readable amount. Six decimals, always, so columns line up. */
export function formatUsdc(minor: string | bigint): string {
    const v = typeof minor === "bigint" ? minor : BigInt(minor);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const whole = abs / 1_000_000n;
    const frac = (abs % 1_000_000n).toString().padStart(6, "0");
    return `${neg ? "-" : ""}${whole}.${frac}`;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly reasons: string[] = [],
    ) {
        super(message);
    }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        ...init,
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const body: unknown = text === "" ? {} : JSON.parse(text);

    if (!res.ok) {
        const o = body as { error?: string; refused?: string[]; stopped?: string[]; details?: string[] };
        // The agent answers a refusal with its reasons rather than a bare failure, so keep them.
        const reasons = o.refused ?? o.stopped ?? o.details ?? [];
        throw new ApiError(res.status, o.error ?? reasons[0] ?? `request failed with ${res.status}`, reasons);
    }
    return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
    call<T>(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });

// ---- shapes the API returns ----

export interface LoginOffer {
    domain: { name: string; version: string; chainId: number };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: { statement: string; address: string; nonce: string; issuedAt: string };
}

export interface Me {
    signedIn: boolean;
    address: string | null;
}

export interface Mandate {
    version: number;
    hash: string;
    prevHash: string | null;
    createdAt: string;
    terms: {
        themes: { id: string; targetBps: number }[];
        maxCompanyBps: number;
        investShareBps: number;
        maxSlippageBps: number;
        driftToleranceBps: number;
        approvalExpirySeconds: number;
        maxTradeUsdc: string;
        minTradeUsdc: string;
        reserveTargetUsdc: string;
    };
}

export interface SyncResult {
    sales: number;
    unattributedSales: number;
    briefsCosted: number;
    unreadableBriefs: { file: string; error: string }[];
    revenueUsdcMinor: string;
    costsUsdcMinor: string;
    investableUsdcMinor: string;
    settled: { briefId: string; investableUsdcMinor: string }[];
}

export interface ProposalLeg {
    symbol: string;
    asset: string;
    theme: string;
    usdcIn: string;
}

export interface SwapOrderView {
    symbol: string;
    usdcIn: string;
    parts: { theme: string; usdcIn: string }[];
}

export interface Proposal {
    id: string;
    state: string;
    hash: string;
    mandateVersion: number;
    mandateHash: string;
    totalUsdcIn: string;
    legs: ProposalLeg[];
    swaps: SwapOrderView[];
    createdAt: string;
    toSign: LoginOffer; // same typed-data shape, different primary type
    warnings: string[];
}

export interface BriefQuote {
    sourceId: string;
    text: string;
}

export interface BriefClaim {
    id: string;
    type: string;
    text: string;
    sourceIds: string[];
    quotes?: BriefQuote[];
}

export interface BriefFit {
    asset: string;
    symbol: string;
    fit: number;
    evidence: number;
    claimIds: string[];
}

export interface BriefTheme {
    themeId: string;
    claims: BriefClaim[];
    fits: BriefFit[];
    gap: boolean;
    gapReason?: string;
}

export interface BriefSource {
    id: string;
    title: string;
    publisher: string;
    url: string;
    publishedAt: string | null;
}

export interface OwnerBrief {
    id: string;
    createdAt: string;
    provider: string;
    model: string;
    costUsdcMinor: string;
    themes: BriefTheme[];
    sources: BriefSource[];
}

export interface LedgerEntry {
    id: number;
    type: string;
    mode: string;
    at: string;
    memo: string | null;
    briefId: string | null;
    lines: { account: string; amount: string }[];
}

export interface InvestLedger {
    mode: string;
    simulatedFills: boolean;
    balances: Record<string, string>;
    entries: LedgerEntry[];
    reconcile: { ok: boolean; issues: string[] };
}

export interface ExecuteResult {
    id: string;
    simulated: boolean;
    warnings: string[];
    fills: { symbol: string; usdcIn: string; price: string; quantity: string }[];
}

export const api = {
    me: () => call<Me>("/auth/me"),
    nonce: () => post<LoginOffer>("/auth/nonce"),
    verify: (nonce: string, signature: string) =>
        post<{ address: string; expiresAt: number }>("/auth/verify", { nonce, signature }),
    logout: () => post<{ signedOut: boolean }>("/auth/logout"),

    mandate: () => call<Mandate>("/mandate"),
    brief: () => call<OwnerBrief>("/invest/brief"),
    ledger: () => call<InvestLedger>("/invest/ledger"),

    sync: () => post<SyncResult>("/invest/sync"),
    propose: (id?: string) => post<Proposal>("/invest/propose", id === undefined ? {} : { id }),
    approve: (id: string, signature: string) =>
        post<{ id: string; approved: boolean; expiresAt: string; signer: string }>("/invest/approve", {
            id,
            signature,
        }),
    execute: (id: string) => post<ExecuteResult>("/invest/execute", { id }),
};
