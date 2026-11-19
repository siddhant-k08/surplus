const ADDRESS = /^0x[0-9a-f]{40}$/;

export const TOKENS_URL = "https://api.coinbase.com/v1/tokenized-stocks";

export interface TokenRecord {
    address: string; // lowercase contract_address
    symbol: string;
    name: string;
    decimals: number;
    isin: string | null;
    multiplier: number | null;
    pausedFeatures: number[];
    navPrice: number | null;
    navUpdatedAt: string | null; // ISO
    totalSupply: number | null;
}

export interface RejectedRecord {
    index: number;
    reason: string;
}

export interface TokenPage {
    tokens: TokenRecord[];
    rejected: RejectedRecord[];
    next: string | null;
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parses one API page. Bad records are reported in `rejected`, never silently kept. */
export function parseTokenPage(json: unknown): TokenPage {
    if (typeof json !== "object" || json === null) {
        throw new Error("Token list response is not an object");
    }
    const body = json as Record<string, unknown>;
    if (!Array.isArray(body.tokens)) {
        throw new Error('Token list response has no "tokens" array');
    }

    const tokens: TokenRecord[] = [];
    const rejected: RejectedRecord[] = [];

    body.tokens.forEach((raw: unknown, index: number) => {
        if (typeof raw !== "object" || raw === null) {
            rejected.push({ index, reason: "record is not an object" });
            return;
        }
        const r = raw as Record<string, unknown>;

        const address = typeof r.contract_address === "string" ? r.contract_address.toLowerCase() : "";
        if (!ADDRESS.test(address)) {
            rejected.push({ index, reason: "invalid or missing contract_address" });
            return;
        }
        const symbol = typeof r.symbol === "string" ? r.symbol.trim() : "";
        if (symbol === "") {
            rejected.push({ index, reason: "missing symbol" });
            return;
        }
        const decimals = r.decimals;
        if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
            rejected.push({ index, reason: "invalid or missing decimals" });
            return;
        }

        const navPrice = num(r.nav_price);
        const navTime = typeof r.nav_price_updated_at === "string" ? Date.parse(r.nav_price_updated_at) : NaN;

        tokens.push({
            address,
            symbol,
            name: typeof r.name === "string" ? r.name : "",
            decimals,
            isin: typeof r.isin === "string" && r.isin !== "" ? r.isin : null,
            multiplier: num(r.multiplier),
            pausedFeatures: Array.isArray(r.paused_features)
                ? r.paused_features.filter((x): x is number => typeof x === "number")
                : [],
            navPrice: navPrice !== null && navPrice > 0 ? navPrice : null,
            navUpdatedAt: Number.isNaN(navTime) ? null : new Date(navTime).toISOString(),
            totalSupply: num(r.total_supply),
        });
    });

    const next =
        typeof body.next_page_token === "string" && body.next_page_token !== ""
            ? body.next_page_token
            : null;
    return { tokens, rejected, next };
}

export async function fetchTokenPage(
    pageToken?: string,
    fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
    const url = new URL(TOKENS_URL);
    url.searchParams.set("page_size", "500");
    if (pageToken !== undefined) url.searchParams.set("page_token", pageToken);
    const res = await fetchImpl(url.toString());
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Token API returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

export interface LoadedTokens {
    tokens: TokenRecord[];
    rejected: RejectedRecord[];
    pages: number;
}

/** Follows next_page_token until it is omitted. Guards against loops and runaway paging. */
export async function loadAllTokens(
    fetchPage: (pageToken?: string) => Promise<unknown> = (t) => fetchTokenPage(t),
    maxPages = 20,
): Promise<LoadedTokens> {
    const byAddress = new Map<string, TokenRecord>();
    const rejected: RejectedRecord[] = [];
    const seenTokens = new Set<string>();
    let token: string | undefined;
    let pages = 0;

    while (true) {
        if (pages >= maxPages) throw new Error(`Stopped after ${maxPages} pages`);
        const page = parseTokenPage(await fetchPage(token));
        pages += 1;
        for (const r of page.rejected) {
            rejected.push({ index: r.index, reason: `page ${pages}: ${r.reason}` });
        }
        for (const t of page.tokens) byAddress.set(t.address, t);
        if (page.next === null) break;
        if (seenTokens.has(page.next)) {
            throw new Error("Page token repeated; aborting to avoid a loop");
        }
        seenTokens.add(page.next);
        token = page.next;
    }
    return { tokens: [...byAddress.values()], rejected, pages };
}

export type NavStatus = "fresh" | "stale" | "missing";

/** Reference-price freshness. NAV is a reference value, never an execution price. */
export function navStatus(t: TokenRecord, now: Date, maxAgeSeconds: number): NavStatus {
    if (t.navPrice === null || t.navUpdatedAt === null) return "missing";
    const ageSeconds = (now.getTime() - Date.parse(t.navUpdatedAt)) / 1000;
    return ageSeconds > maxAgeSeconds ? "stale" : "fresh";
}

export interface Tradability {
    ok: boolean;
    reasons: string[];
}

/** Conservative screen. The meaning of each paused feature flag is not verified, so any flag blocks. */
export function tradability(t: TokenRecord): Tradability {
    const reasons: string[] = [];
    if (t.pausedFeatures.length > 0) {
        reasons.push(`paused features present: ${t.pausedFeatures.join(",")}`);
    }
    if (t.multiplier === null || t.multiplier <= 0) {
        reasons.push("multiplier missing or not positive");
    }
    return { ok: reasons.length === 0, reasons };
}