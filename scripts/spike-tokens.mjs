import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://api.coinbase.com/v1/tokenized-stocks";
const all = [];
let pageToken;
let pages = 0;

do {
    const url = new URL(BASE);
    url.searchParams.set("page_size", "500");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url);
    if (!res.ok) {
        console.error(`HTTP ${res.status}: ${await res.text()}`);
        process.exit(1);
    }
    const body = await res.json();
    all.push(...(body.tokens ?? []));
    pageToken = body.next_page_token;
    pages += 1;
} while (pageToken && pages < 20);

await mkdir("docs", { recursive: true });
await writeFile(
    "docs/tokens.snapshot.json",
    JSON.stringify({ fetchedAt: new Date().toISOString(), tokens: all }, null, 2),
);

console.log(`Pages: ${pages}, tokens: ${all.length}`);
console.table(
    all.map((t) => ({
        symbol: t.symbol,
        address: t.contract_address,
        multiplier: t.multiplier,
        nav: t.nav_price,
        navAt: t.nav_price_updated_at,
        paused: (t.paused_features ?? []).join(","),
    })),
);