import { mkdir, readFile, writeFile } from "node:fs/promises";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

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

// 1. Cross-check the saved API snapshot against the registry
const snapshot = JSON.parse(await readFile("docs/tokens.snapshot.json", "utf8"));
const byAddr = new Map(snapshot.tokens.map((t) => [t.contract_address.toLowerCase(), t]));
console.log("Registry check:");
for (const [symbol, address] of REGISTRY) {
    const t = byAddr.get(address);
    const status = !t ? "NOT IN API" : t.symbol === symbol ? "ok" : `SYMBOL MISMATCH (${t.symbol})`;
    console.log(" ", symbol.padEnd(8), status);
}
const inBoth = REGISTRY.filter(([, a]) => byAddr.has(a)).length;
console.log(`API-only tokens (excluded): ${snapshot.tokens.length - inBoth}`);

// 2. Survey USDC pools from DexScreener (public, no key)
const url = `https://api.dexscreener.com/tokens/v1/base/${REGISTRY.map(([, a]) => a).join(",")}`;
const res = await fetch(url);
if (!res.ok) {
    console.error(`DexScreener HTTP ${res.status}`);
    process.exit(1);
}
const body = await res.json();
const pairs = Array.isArray(body) ? body : (body.pairs ?? []);

await mkdir("docs", { recursive: true });
await writeFile(
    "docs/liquidity.snapshot.json",
    JSON.stringify({ fetchedAt: new Date().toISOString(), pairs }, null, 2),
);
console.log(`\nPairs returned: ${pairs.length}`);
if (pairs[0]) console.log("Keys of first pair:", Object.keys(pairs[0]));

const sides = (p) => [p.baseToken?.address, p.quoteToken?.address].map((a) => (a ?? "").toLowerCase());

const rows = REGISTRY.map(([symbol, address]) => {
    const pools = pairs
        .filter((p) => p.chainId === "base" && sides(p).includes(address) && sides(p).includes(USDC))
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const top = pools[0];
    return {
        symbol,
        usdcPools: pools.length,
        topDex: top?.dexId,
        labels: (top?.labels ?? []).join(","),
        topLiquidityUsd: Math.round(top?.liquidity?.usd ?? 0),
        vol24hUsd: Math.round(top?.volume?.h24 ?? 0),
        priceUsd: top?.priceUsd,
    };
});
console.table(rows);