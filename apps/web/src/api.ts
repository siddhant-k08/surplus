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

/**
 * Statuses worth trying again, and only for reads.
 *
 * The agent runs on a host that starts an instance on demand, and an instance that is still finding
 * its database answers 503 for a moment. Showing a person "could not reach the agent" because they
 * were the first visitor in an hour is a failure of the page, not of the agent.
 *
 * A write is never retried. A POST here can settle a payment, approve a trade or spend a nonce, and
 * repeating one is not a retry: it is a second attempt at moving money. If a write is interrupted the
 * person is told, and they decide.
 */
const RETRIABLE = new Set([502, 503, 504]);
const BACKOFF_MS = [250, 750];

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const mayRetry = method === "GET";

    for (let attempt = 0; ; attempt += 1) {
        let res: Response;
        try {
            res = await fetch(path, {
                ...init,
                credentials: "same-origin",
                headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
            });
        } catch (e) {
            // the network itself failed, which for a read is worth one more go
            if (mayRetry && attempt < BACKOFF_MS.length) {
                await wait(BACKOFF_MS[attempt]!);
                continue;
            }
            throw e;
        }

        if (mayRetry && RETRIABLE.has(res.status) && attempt < BACKOFF_MS.length) {
            await wait(BACKOFF_MS[attempt]!);
            continue;
        }

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
}

/** A read, with the retry above. Exported so every page shares one idea of what a flaky read is. */
export const get = <T>(path: string): Promise<T> => call<T>(path);

const post = <T>(path: string, body?: unknown): Promise<T> =>
    call<T>(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });

// ---- shapes the API returns ----

export interface LoginOffer {
    domain: { name: string; version: string; chainId: number };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: { statement: string; address: string; nonce: string; issuedAt: string };
}

/** What a buyer signs to prove the wallet that paid. Same shape the owner's sign-in offers. */
export interface RecoveryOffer {
    domain: { name: string; version: string; chainId: number };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: { statement: string; address: string; nonce: string; issuedAt: string };
}

export interface RecoveredReceipt {
    id: string;
    url: string;
    briefId: string;
    transaction: string;
    amountUsdcMinor: string;
    at: string;
}

/** Offers the payload the buyer's wallet should sign. */
export const recoveryOffer = (address: string): Promise<RecoveryOffer> =>
    post<RecoveryOffer>("/receipt/nonce", { address });

/** Exchanges a signature for the links that wallet paid for. */
export const recoverReceipts = (body: { address: string; nonce: string; signature: string }): Promise<{
    address: string;
    receipts: RecoveredReceipt[];
}> => post("/receipt/recover", body);

export interface Me {
    signedIn: boolean;
    address: string | null;
}

/**
 * Every term the mandate carries, matching `MandateTerms` in core and `parseTermsUpdate` on the server.
 *
 * The earlier version of this type listed only the terms the desk happened to display, which meant the
 * desk could not show an owner a constraint their own mandate holds. Amounts stay decimal strings and
 * percentages stay basis points: converting either in the browser is how rounding gets into money.
 */
export interface MandateTerms {
    /** Token addresses the agent may buy. Set by the registry, editable by the owner. */
    eligible: string[];
    themes: { id: string; targetBps: number }[];
    maxCompanyBps: number;
    investShareBps: number;
    maxSlippageBps: number;
    driftToleranceBps: number;
    approvalExpirySeconds: number;
    maxTradeUsdc: string;
    minTradeUsdc: string;
    reserveTargetUsdc: string;
    /** Optional in core: absent means the mandate does not carry the constraint at all. */
    investOnlyWhenAhead?: boolean;
    /**
     * When the agent may sell on its own. All three are optional, and all three mean something by being
     * absent: with none of them set the agent proposes no sale at all. Absence is the mandate
     * withholding permission, not a value waiting to be filled in.
     */
    takeProfitBps?: number;
    stopLossBps?: number;
    rebalanceBandBps?: number;
}

/** The terms whose absence is a state, and which therefore need a way to be removed. */
export type ExitTerm = "takeProfitBps" | "stopLossBps" | "rebalanceBandBps";

export interface Mandate {
    version: number;
    hash: string;
    prevHash: string | null;
    createdAt: string;
    terms: MandateTerms;
}

/**
 * A mandate update, as the owner's edits leave the form. Only changed terms are sent.
 *
 * An exit term may also be sent as null, which is how removal is said. The server carries over every
 * term an update does not mention, so leaving one out cannot remove it, and for these three the
 * difference matters: unsetting them is how an owner takes back permission to sell.
 */
export type TermsUpdate = Partial<Omit<MandateTerms, ExitTerm>> & { [K in ExitTerm]?: number | null };

export interface MandateSaved extends Mandate {
    /** What actually changed, named by the server rather than guessed at by the page. */
    changed: string[];
    note: string;
}

export interface MandateHistory {
    /** Whether the stored chain of versions still verifies. False means the file was altered. */
    chainVerified: boolean;
    versions: Mandate[];
}

/** What stands between the books as they are and the smallest trade the mandate allows. */
export interface InvestmentGap {
    canInvest: boolean;
    /** Costs revenue has not covered yet. Nothing reaches the reserve until this is zero. */
    shortfallUsdcMinor: string;
    /** What the protected reserve still needs. */
    reserveGapUsdcMinor: string;
    /** Surplus needed after that, so the invest share clears the minimum trade. */
    surplusNeededUsdcMinor: string;
    /** Revenue that would have to arrive before a trade is possible. */
    revenueNeededUsdcMinor: string;
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
    gap: InvestmentGap;
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
    /** The filing itself. The API has always sent this; the page used not to show it. */
    url: string;
    publishedAt: string | null;
}

/** What `/receipt/:id` answers. The brief is the same shape the owner's desk reads. */
export interface PaidReceipt {
    receipt: {
        transaction: string;
        amountUsdcMinor: string;
        at: string;
        /** null on receipts written before the network was stored. Never inferred from config. */
        network: string | null;
    };
    brief: {
        id: string;
        createdAt: string;
        disclaimer: string;
        sources: BriefSource[];
        themes: BriefTheme[];
    };
    provider: string;
    model: string;
}

/**
 * What the agent has put behind its own research. Public, and the one claim a brief cannot prove alone.
 *
 * `simulated` is not decoration. While it is true this describes money the agent decided to spend
 * rather than money that moved, and every surface showing these numbers has to say so.
 */
export interface BackedAsset {
    asset: string;
    /** null for a token outside Base's registry, which should never have been bought. */
    symbol: string | null;
    usdcMinor: string;
    fills: number;
    /** Exits out of this holding. A holding fully sold is absent, not listed at zero. */
    sales: number;
    onchainFills: number;
    transactions: string[];
}

export interface BackedTheme {
    theme: string;
    usdcMinor: string;
    assets: BackedAsset[];
}

export interface BriefBacking {
    briefId: string;
    usdcMinor: string;
    mode: string;
    simulated: boolean;
    fills: number;
    sales: number;
    onchainFills: number;
    firstAt: string;
    lastAt: string;
    themes: BackedTheme[];
}

export interface Backing {
    /** Committed on the strength of a brief. The headline, and smaller than `totalUsdcMinor`. */
    attributedUsdcMinor: string;
    totalUsdcMinor: string;
    /** Positions no brief can be shown to have justified. Shown, never folded into the headline. */
    unattributed: { usdcMinor: string; fills: number };
    briefs: BriefBacking[];
}

export const backing = (): Promise<Backing> => get<Backing>("/catalogue/backing");

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
    gap: InvestmentGap;
}

/** The books against the chain: units recorded as bought, against units the wallet holds. */
export interface PositionsView {
    /** False when fills are simulated, so there is nothing onchain to compare. */
    checked: boolean;
    why?: string;
    ok?: boolean;
    positions: {
        asset: string;
        symbol: string;
        bookedUnits: string;
        heldUnits: string;
        differenceUnits: string;
        verdict: "matches" | "short" | "extra";
    }[];
    issues: string[];
}

/** What pressing execute would actually do. Asked of the agent, never inferred from config. */
export interface ExecutionStatus {
    willSendRealSwaps: boolean;
    why?: string;
    address?: string;
    capUsdcMinor?: string;
    spentUsdcMinor?: string;
    remainingUsdcMinor?: string;
    unresolved: { key: string; symbol: string; txHash?: string; usdcInMinor: string }[];
}

export interface ExecuteResult {
    id: string;
    simulated: boolean;
    warnings: string[];
    fills: { symbol: string; usdcIn: string; price: string; quantity: string }[];
}

/**
 * Where each theme sits against its target, from live sell quotes.
 *
 * Read on demand rather than with the page: it costs one quote per token held, and a mandate page
 * opened to change the reserve has no business spending that.
 */
export interface ThemeDrift {
    theme: string;
    valueUsdcMinor: string;
    actualBps: number;
    /** Renormalised over the themes that hold something, which is what the agent trims against. */
    targetBps: number;
    driftBps: number;
    excessUsdcMinor: string;
    overBand: boolean;
}

export interface DriftReading {
    themes: ThemeDrift[];
    totalUsdcMinor: string;
    untargetedUsdcMinor: string;
    /** The rule this is measured against, or null when the mandate states none. */
    bandBps: number | null;
    asOf: string;
}

export const api = {
    me: () => call<Me>("/auth/me"),
    nonce: () => post<LoginOffer>("/auth/nonce"),
    verify: (nonce: string, signature: string) =>
        post<{ address: string; expiresAt: number }>("/auth/verify", { nonce, signature }),
    logout: () => post<{ signedOut: boolean }>("/auth/logout"),

    mandate: () => call<Mandate>("/mandate"),
    mandateHistory: () => call<MandateHistory>("/mandate/history"),
    /** Sends only the terms that changed; the server carries the rest over. Never retried. */
    updateMandate: (terms: TermsUpdate) => post<MandateSaved>("/mandate", terms),
    drift: () => get<DriftReading>("/invest/drift"),
    brief: () => call<OwnerBrief>("/invest/brief"),
    ledger: () => call<InvestLedger>("/invest/ledger"),

    sync: () => post<SyncResult>("/invest/sync"),
    execution: () => call<ExecutionStatus>("/invest/execution"),
    positions: () => call<PositionsView>("/invest/positions"),
    propose: (id?: string) => post<Proposal>("/invest/propose", id === undefined ? {} : { id }),
    approve: (id: string, signature: string) =>
        post<{ id: string; approved: boolean; expiresAt: string; signer: string }>("/invest/approve", {
            id,
            signature,
        }),
    execute: (id: string) => post<ExecuteResult>("/invest/execute", { id }),
};
