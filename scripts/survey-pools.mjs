import { mkdir, writeFile } from "node:fs/promises";

// Must match packages/core/src/registry.ts
const REGISTRY = [
    ["NVDAc", "0xb20000000000000000000078ee7ce2fe4908108c"],
    ["METAc", "0xb2000000000000000000008bc8786b856e61707c"],
    ["AAPLc", "0xb200000000000000000000c2e324d24d7eecd1fb"],
    ["GOOGLc", "0xb2000000000000000000002d0ba3164cc74f58b7"],
    ["AMZNc", "0xb200000000000000000000d9192b6b456483c2e8"],
    ["MSFTc", "0xb200000000000000000000ab99cfa739e253872b"],
    ["MSTRc", "0xb2000000000000000000004884b426556b92883d"],
    ["SNDKc", "0xb200000000000000000000397293cb8cda9a10c5"],
    ["SPCXc", "0xb2000000000000000000007b9fcbd005511acbd5"],
    ["TSLAc", "0xb2000000000000000000001e800a7f5189430cd0"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = {};
const rows = [];

for (const [symbol, address] of REGISTRY) {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/base/${address}`);
    if (!res.ok) {
        console.error(`${symbol}: HTTP ${res.status}`);
        rows.push({ symbol, dex: `HTTP ${res.status}` });
        await sleep(400);
        continue;
    }
    const body = await res.json();
    const pairs = (Array.isArray(body) ? body : (body.pairs ?? [])).filter((p) => p.chainId === "base");
    all[symbol] = pairs;

    if (pairs.length === 0) rows.push({ symbol, dex: "(no pools)" });
    for (const p of pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))) {
        const stockIsBase = p.baseToken?.address?.toLowerCase() === address;
        rows.push({
            symbol,
            dex: p.dexId,
            labels: (p.labels ?? []).join(","),
            against: stockIsBase ? p.quoteToken?.symbol : p.baseToken?.symbol,
            liquidityUsd: Math.round(p.liquidity?.usd ?? 0),
            vol24hUsd: Math.round(p.volume?.h24 ?? 0),
            pair: p.pairAddress,
        });
    }
    await sleep(400);
}

await mkdir("docs", { recursive: true });
await writeFile(
    "docs/pools.snapshot.json",
    JSON.stringify({ fetchedAt: new Date().toISOString(), pools: all }, null, 2),
);
console.table(rows);