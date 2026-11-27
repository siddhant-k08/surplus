import { describe, expect, it } from "vitest";
import {
    EdgarClient,
    EdgarDocProvider,
    SEC_TICKERS_URL,
    filingUrl,
    htmlToText,
    latestByForm,
    currentFilings,
    parseRecentFilings,
    parseTickerMap,
    submissionsUrl,
    underlyingTicker,
} from "../src/edgar";
import type { CandidateCompany, ThemeSpec } from "../src/pipeline";

const UA = "Surplus Test test@example.com";
const tickersJson = {
    "0": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
    "1": { cik_str: 1318605, ticker: "TSLA", title: "Tesla, Inc." },
};
const submissions = {
    filings: {
        recent: {
            accessionNumber: ["0001045810-26-000100", "0001045810-26-000050", "0001045810-26-000010", "0001045810-26-000001"],
            form: ["8-K", "10-Q", "10-K", "10-Q"],
            filingDate: ["2026-11-01", "2026-08-27", "2026-02-25", "2025-11-19"],
            reportDate: ["", "2026-07-27", "2026-01-25", "2025-10-26"],
            primaryDocument: ["a8k.htm", "nvda-q2.htm", "nvda-10k.htm", "nvda-q3.htm"],
        },
    },
};
const filingHtml =
    "<html><head><title>x</title></head><body><div style='display:none'><ix:header>HIDDEN XBRL</ix:header></div>" +
    "<p>Data Center revenue was a record, up&nbsp;112% from a year ago.</p><table><tr><td>Revenue</td><td>&#36;10</td></tr></table><script>bad()</script></body></html>";

interface Call { url: string; ua: string | null }
function fakeFetch(routes: Record<string, unknown>, calls: Call[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, ua: new Headers(init?.headers).get("User-Agent") });
        if (!(url in routes)) return new Response("not found", { status: 404 });
        const body = routes[url];
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
}

const NVDA: CandidateCompany = { asset: "0x" + "a".repeat(40), symbol: "NVDAc", name: "NVIDIA" };
const SPCX: CandidateCompany = { asset: "0x" + "c".repeat(40), symbol: "SPCXc", name: "SpaceX" };
const theme: ThemeSpec = { id: "ai", name: "AI", description: "chips" };

describe("parsers", () => {
    it("maps tickers to 10-digit CIKs", () => {
        const m = parseTickerMap(tickersJson);
        expect(m.get("NVDA")).toEqual({ cik10: "0001045810", ticker: "NVDA", title: "NVIDIA CORP" });
        expect(() => parseTickerMap({ a: { foo: 1 } })).toThrow(/zero entries/);
    });
    it("reads columnar filings and picks the newest per form", () => {
        const rows = parseRecentFilings(submissions);
        expect(rows.length).toBe(4);
        expect(rows[0]?.reportDate).toBeNull();
        const latest = latestByForm(rows, ["10-K", "10-Q", "S-1"]);
        expect(latest.map((f) => f.primaryDocument)).toEqual(["nvda-10k.htm", "nvda-q2.htm"]);
        expect(() => parseRecentFilings({})).toThrow();
    });
    it("builds archive URLs and rejects odd names", () => {
        const f = parseRecentFilings(submissions)[2]!;
        expect(filingUrl("0001045810", f)).toBe("https://www.sec.gov/Archives/edgar/data/1045810/000104581026000010/nvda-10k.htm");
        expect(() => filingUrl("0001045810", { ...f, primaryDocument: "../x" })).toThrow();
    });
    it("turns filing HTML into paragraph text without hidden XBRL or scripts", () => {
        const t = htmlToText(filingHtml);
        expect(t).toContain("Data Center revenue was a record, up 112% from a year ago.");
        expect(t).toContain("Revenue $10");
        expect(t).not.toContain("HIDDEN");
        expect(t).not.toContain("bad()");
        expect(t).toMatch(/\n\n/);
    });
    it("derives listed tickers from token symbols", () => {
        expect(underlyingTicker("NVDAc")).toBe("NVDA");
        expect(underlyingTicker("GOOGLc")).toBe("GOOGL");
        expect(underlyingTicker("nvda")).toBeNull();
        expect(underlyingTicker("NVDA")).toBeNull();
    });
});

describe("EdgarClient", () => {
    it("refuses a User-Agent without a contact email", () => {
        expect(() => new EdgarClient({ userAgent: "anonymous" })).toThrow(/contact email/);
    });
    it("spaces requests and sends the User-Agent on each", async () => {
        const calls: Call[] = [];
        const slept: number[] = [];
        let t = 0;
        const c = new EdgarClient({
            userAgent: UA,
            fetchImpl: fakeFetch({ [SEC_TICKERS_URL]: tickersJson, "https://x/a": "a" }, calls),
            minIntervalMs: 150,
            nowMs: () => t,
            sleep: async (ms) => { slept.push(ms); t += ms; },
        });
        await c.tickerMap();
        await c.tickerMap(); // cached, no second request
        await c.getText("https://x/a");
        expect(calls.length).toBe(2);
        expect(calls.every((x) => x.ua === UA)).toBe(true);
        expect(slept).toEqual([150]);
    });
    it("throws on HTTP errors", async () => {
        const c = new EdgarClient({ userAgent: UA, fetchImpl: fakeFetch({}, []), minIntervalMs: 0 });
        await expect(c.getText("https://x/missing")).rejects.toThrow(/HTTP 404/);
    });
});

describe("EdgarDocProvider", () => {
    const routes = {
        [SEC_TICKERS_URL]: tickersJson,
        [submissionsUrl("0001045810")]: submissions,
        "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000010/nvda-10k.htm": filingHtml,
        "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000050/nvda-q2.htm": filingHtml,
    };
    it("returns tier 1 docs, caches across themes, and reports unresolvable companies", async () => {
        const calls: Call[] = [];
        const client = new EdgarClient({ userAgent: UA, fetchImpl: fakeFetch(routes, calls), minIntervalMs: 0 });
        const p = new EdgarDocProvider(client, { now: () => new Date("2026-11-21T00:00:00Z") });
        const docs = await p.fetchDocs(theme, [NVDA, SPCX]);
        expect(docs.map((d) => d.id)).toEqual(["NVDA-10-K-0001045810-26-000010", "NVDA-10-Q-0001045810-26-000050"]);
        expect(docs.every((d) => d.tier === 1 && d.publisher === "SEC EDGAR" && d.asset === NVDA.asset)).toBe(true);
        expect(docs[0]?.title).toBe("NVIDIA CORP 10-K for period ending 2026-01-25");
        expect(p.warnings.join("|")).toContain("SPCXc: ticker SPCX not in SEC ticker file");
        const before = calls.length;
        await p.fetchDocs({ ...theme, id: "other" }, [NVDA, SPCX]);
        expect(calls.length).toBe(before);
    });
    it("keeps going when one filing fails and truncates very long text", async () => {
        const { ["https://www.sec.gov/Archives/edgar/data/1045810/000104581026000050/nvda-q2.htm"]: _gone, ...partial } = routes;
        const client = new EdgarClient({ userAgent: UA, fetchImpl: fakeFetch(partial, []), minIntervalMs: 0 });
        const p = new EdgarDocProvider(client, { maxDocChars: 30 });
        const docs = await p.fetchDocs(theme, [NVDA]);
        expect(docs.length).toBe(1);
        expect(docs[0]?.text.length).toBe(30);
        expect(p.warnings.join("|")).toMatch(/10-Q: SEC returned HTTP 404/);
        expect(p.warnings.join("|")).toMatch(/truncated/);
    });
});
describe("annual reports", () => {
    const filing = (form: string, filingDate: string) =>
        ({ form, filingDate, accessionNumber: "1-1-1", reportDate: null, primaryDocument: "a.htm" });
    const forms = ["10-K", "20-F", "10-Q"];

    it("reads a foreign issuer's 20-F", () => {
        expect(currentFilings([filing("20-F", "2026-03-01")], forms).map((f) => f.form)).toEqual(["20-F"]);
    });

    it("drops the superseded one when a company changed forms", () => {
        const rows = [filing("20-F", "2023-03-01"), filing("10-K", "2026-02-01"), filing("10-Q", "2026-05-01")];
        expect(currentFilings(rows, forms).map((f) => f.form)).toEqual(["10-K", "10-Q"]);
    });
});
