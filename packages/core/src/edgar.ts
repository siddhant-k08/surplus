import { HTTP_TIMEOUT_MS } from "./quote";
import type { CandidateCompany, DocProvider, SourceDoc, ThemeSpec } from "./pipeline";

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const submissionsUrl = (cik10: string): string => `https://data.sec.gov/submissions/CIK${cik10}.json`;

export interface TickerInfo {
    cik10: string; // 10 digits with leading zeros
    ticker: string;
    title: string;
}

export interface Filing {
    accessionNumber: string;
    form: string;
    filingDate: string;
    reportDate: string | null;
    primaryDocument: string;
}

/** Parses company_tickers.json. Field names are confirmed by scripts/spike-edgar.mjs, not by SEC documentation. */
export function parseTickerMap(json: unknown): Map<string, TickerInfo> {
    if (typeof json !== "object" || json === null) throw new Error("ticker file is not an object");
    const out = new Map<string, TickerInfo>();
    for (const v of Object.values(json as Record<string, unknown>)) {
        if (typeof v !== "object" || v === null) continue;
        const r = v as Record<string, unknown>;
        const cik = typeof r.cik_str === "number" || typeof r.cik_str === "string" ? String(r.cik_str) : "";
        const ticker = typeof r.ticker === "string" ? r.ticker.toUpperCase() : "";
        if (!/^\d{1,10}$/.test(cik) || ticker === "") continue;
        if (out.has(ticker)) continue; // first entry wins
        out.set(ticker, { cik10: cik.padStart(10, "0"), ticker, title: typeof r.title === "string" ? r.title : "" });
    }
    if (out.size === 0) throw new Error("ticker file parsed to zero entries; check the field names");
    return out;
}

/** Reads the columnar filings.recent arrays into rows. Rows with missing fields are skipped. */
export function parseRecentFilings(json: unknown): Filing[] {
    const filings = (json as { filings?: { recent?: Record<string, unknown> } } | null)?.filings?.recent;
    if (!filings) throw new Error("submissions JSON has no filings.recent");
    const col = (k: string): unknown[] => (Array.isArray(filings[k]) ? (filings[k] as unknown[]) : []);
    const acc = col("accessionNumber");
    const form = col("form");
    const fd = col("filingDate");
    const rd = col("reportDate");
    const doc = col("primaryDocument");
    const rows: Filing[] = [];
    for (let i = 0; i < acc.length; i++) {
        const a = acc[i], f = form[i], d = fd[i], p = doc[i], r = rd[i];
        if (typeof a !== "string" || typeof f !== "string" || typeof d !== "string" || typeof p !== "string" || p === "") continue;
        rows.push({ accessionNumber: a, form: f, filingDate: d, reportDate: typeof r === "string" && r !== "" ? r : null, primaryDocument: p });
    }
    return rows;
}

/** Newest filing for each requested form, in the order the forms were given. */
export function latestByForm(filings: readonly Filing[], forms: readonly string[]): Filing[] {
    const out: Filing[] = [];
    for (const form of forms) {
        const hits = filings.filter((f) => f.form === form).sort((a, b) => b.filingDate.localeCompare(a.filingDate));
        if (hits[0]) out.push(hits[0]);
    }
    return out;
}

export function filingUrl(cik10: string, f: Filing): string {
    const cik = String(Number(cik10));
    const folder = f.accessionNumber.replace(/-/g, "");
    if (!/^\d+$/.test(folder) || !/^[A-Za-z0-9._-]+$/.test(f.primaryDocument)) {
        throw new Error(`unexpected accession or document name: ${f.accessionNumber} ${f.primaryDocument}`);
    }
    return `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${f.primaryDocument}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "..." };

/** Rough HTML to text for filings. Block tags become paragraph breaks so passages stay meaningful. */
export function htmlToText(html: string): string {
    return html
        .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n\n")
        .replace(/<\/t[dh]>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
        .replace(/[ \t\u00a0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export interface EdgarClientOptions {
    userAgent: string;
    fetchImpl?: typeof fetch;
    minIntervalMs?: number; // SEC allows 10 per second; default 150 ms keeps us well under
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
}

/** Sequential, rate-spaced SEC client. Every request carries the declared User-Agent. */
export class EdgarClient {
    private last = Number.NEGATIVE_INFINITY;
    private readonly fetchImpl: typeof fetch;
    private readonly minIntervalMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly nowMs: () => number;
    private tickers: Map<string, TickerInfo> | null = null;
    requests = 0;

    constructor(private readonly opts: EdgarClientOptions) {
        if (!/\S+@\S+\.\S+/.test(opts.userAgent)) {
            throw new Error("SEC_USER_AGENT must include a name and a contact email, e.g. 'Surplus Demo you@example.com'");
        }
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.minIntervalMs = opts.minIntervalMs ?? 150;
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.nowMs = opts.nowMs ?? (() => Date.now());
    }

    private async get(url: string): Promise<Response> {
        const wait = this.last + this.minIntervalMs - this.nowMs();
        if (wait > 0) await this.sleep(wait);
        this.last = this.nowMs();
        this.requests += 1;
        const res = await this.fetchImpl(url, {
            headers: { "User-Agent": this.opts.userAgent, "Accept-Encoding": "gzip, deflate" },
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? HTTP_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`SEC returned HTTP ${res.status} for ${url}`);
        return res;
    }

    async getJson(url: string): Promise<unknown> {
        return (await this.get(url)).json();
    }

    async getText(url: string): Promise<string> {
        return (await this.get(url)).text();
    }

    async tickerMap(): Promise<Map<string, TickerInfo>> {
        if (!this.tickers) this.tickers = parseTickerMap(await this.getJson(SEC_TICKERS_URL));
        return this.tickers;
    }
}

/** Token symbol to listed ticker: "NVDAc" -> "NVDA". Anything else returns null and is reported. */
export function underlyingTicker(symbol: string): string | null {
    const m = /^([A-Z][A-Z.]{0,9})c$/.exec(symbol);
    return m?.[1] ?? null;
}

export interface EdgarProviderOptions {
    forms?: readonly string[];
    maxDocChars?: number;
    now?: () => Date;
    tickerOf?: (c: CandidateCompany) => string | null;
}

/**
 * Supplies each candidate's latest primary filings as tier 1 sources. Filings are fetched once and reused
 * across themes. Companies that cannot be resolved are recorded in `warnings`, not silently skipped.
 */
export class EdgarDocProvider implements DocProvider {
    readonly warnings: string[] = [];
    private readonly cache = new Map<string, SourceDoc[]>();
    private readonly forms: readonly string[];
    private readonly maxDocChars: number;
    private readonly now: () => Date;
    private readonly tickerOf: (c: CandidateCompany) => string | null;

    constructor(private readonly client: EdgarClient, opts: EdgarProviderOptions = {}) {
        this.forms = opts.forms ?? ["10-K", "10-Q"];
        this.maxDocChars = opts.maxDocChars ?? 800_000;
        this.now = opts.now ?? (() => new Date());
        this.tickerOf = opts.tickerOf ?? ((c) => underlyingTicker(c.symbol));
    }

    private async docsFor(c: CandidateCompany): Promise<SourceDoc[]> {
        const hit = this.cache.get(c.asset);
        if (hit) return hit;
        const docs: SourceDoc[] = [];
        this.cache.set(c.asset, docs);

        const ticker = this.tickerOf(c);
        if (!ticker) {
            this.warnings.push(`${c.symbol}: cannot derive a listed ticker`);
            return docs;
        }
        const info = (await this.client.tickerMap()).get(ticker);
        if (!info) {
            this.warnings.push(`${c.symbol}: ticker ${ticker} not in SEC ticker file (it may not file with the SEC)`);
            return docs;
        }
        let filings: Filing[];
        try {
            filings = latestByForm(parseRecentFilings(await this.client.getJson(submissionsUrl(info.cik10))), this.forms);
        } catch (e) {
            this.warnings.push(`${c.symbol}: submissions error: ${(e as Error).message}`);
            return docs;
        }
        if (filings.length === 0) this.warnings.push(`${c.symbol}: no ${this.forms.join("/")} filings found`);
        for (const f of filings) {
            try {
                const url = filingUrl(info.cik10, f);
                let text = htmlToText(await this.client.getText(url));
                if (text.length > this.maxDocChars) {
                    this.warnings.push(`${c.symbol} ${f.form}: truncated to ${this.maxDocChars} characters`);
                    text = text.slice(0, this.maxDocChars);
                }
                docs.push({
                    id: `${ticker}-${f.form}-${f.accessionNumber}`.replace(/[^A-Za-z0-9-]/g, "-"),
                    tier: 1,
                    title: `${info.title} ${f.form}${f.reportDate ? ` for period ending ${f.reportDate}` : ""}`,
                    publisher: "SEC EDGAR",
                    url,
                    publishedAt: f.filingDate,
                    retrievedAt: this.now().toISOString(),
                    text,
                    asset: c.asset,
                });
            } catch (e) {
                this.warnings.push(`${c.symbol} ${f.form}: ${(e as Error).message}`);
            }
        }
        return docs;
    }

    async fetchDocs(_theme: ThemeSpec, companies: readonly CandidateCompany[]): Promise<SourceDoc[]> {
        const all: SourceDoc[] = [];
        for (const c of companies) all.push(...(await this.docsFor(c)));
        return all;
    }
}