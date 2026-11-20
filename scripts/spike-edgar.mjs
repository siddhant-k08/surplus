// Read-only check of the SEC data shapes the EDGAR client relies on. Prints keys, not whole files.
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");

const UA = process.env.SEC_USER_AGENT ?? "";
if (!/\S+@\S+\.\S+/.test(UA)) {
  console.error("Set SEC_USER_AGENT in .env, e.g. SEC_USER_AGENT=Surplus Demo you@example.com");
  process.exit(1);
}
const headers = { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers });
console.log("company_tickers.json HTTP", tRes.status);
const tickers = await tRes.json();
const first = Object.values(tickers)[0];
console.log("entries:", Object.keys(tickers).length, "first record keys:", Object.keys(first ?? {}));
const want = ["NVDA", "META", "AAPL", "GOOGL", "AMZN", "MSFT", "MSTR", "SNDK", "SPCX", "TSLA"];
for (const t of want) {
  const hit = Object.values(tickers).find((r) => r.ticker === t);
  console.log(t.padEnd(6), hit ? `CIK ${hit.cik_str}  ${hit.title}` : "NOT FOUND");
}

await sleep(200);
const sRes = await fetch("https://data.sec.gov/submissions/CIK0001045810.json", { headers });
console.log("\nsubmissions (NVIDIA) HTTP", sRes.status);
const sub = await sRes.json();
console.log("top-level keys:", Object.keys(sub));
console.log("filings keys:", Object.keys(sub.filings ?? {}));
const recent = sub.filings?.recent ?? {};
console.log("filings.recent keys:", Object.keys(recent));
const n = (recent.form ?? []).length;
for (let i = 0, shown = 0; i < n && shown < 3; i++) {
  if (!["10-K", "10-Q"].includes(recent.form[i])) continue;
  shown++;
  console.log(" ", recent.form[i], recent.filingDate?.[i], recent.accessionNumber?.[i], recent.primaryDocument?.[i]);
}