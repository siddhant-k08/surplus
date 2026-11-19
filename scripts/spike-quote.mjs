import { mkdir, readFile, writeFile } from "node:fs/promises";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AMOUNT_IN = "1000000"; // 1 USDC in minor units

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

const snapshot = JSON.parse(await readFile("docs/tokens.snapshot.json", "utf8"));
const decimalsOf = new Map(snapshot.tokens.map((t) => [t.contract_address.toLowerCase(), t.decimals]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const raw = {};

for (const [symbol, address] of REGISTRY) {
    const url = new URL("https://aggregator-api.kyberswap.com/base/api/v1/routes");
    url.searchParams.set("tokenIn", USDC);
    url.searchParams.set("tokenOut", address);
    url.searchParams.set("amountIn", AMOUNT_IN);
    url.searchParams.set("slippageTolerance", "100");
    url.searchParams.set("source", "surplus-hackathon");

    let status = "error";
    let message = "";
    let row = { symbol };
    try {
        const res = await fetch(url);
        status = res.status;
        const body = await res.json().catch(() => null);
        raw[symbol] = body;
        message = body?.message ?? "";
        const rs = body?.data?.routeSummary;
        if (rs?.amountOut) {
            const dec = decimalsOf.get(address) ?? 18;
            const out = Number(BigInt(rs.amountOut)) / 10 ** dec;
            row = {
                symbol,
                status,
                message,
                amountOut: rs.amountOut,
                impliedUsdcPerToken: out > 0 ? (1 / out).toFixed(4) : "n/a",
                amountOutUsd: rs.amountOutUsd,
                gasUsd: rs.gasUsd,
                routeKeys: Object.keys(rs).length,
            };
        } else {
            row = { symbol, status, message: message || "no routeSummary in response" };
        }
    } catch (e) {
        row = { symbol, status, message: String(e).slice(0, 80) };
    }
    rows.push(row);
    await sleep(500);
}

await mkdir("docs", { recursive: true });
await writeFile(
    "docs/quote.snapshot.json",
    JSON.stringify({ fetchedAt: new Date().toISOString(), amountInUsdcMinor: AMOUNT_IN, raw }, null, 2),
);
console.table(rows);
const first = raw.NVDAc?.data?.routeSummary;
if (first) console.log("routeSummary keys (NVDAc):", Object.keys(first));
const firstTop = raw.NVDAc ? Object.keys(raw.NVDAc) : [];
console.log("top-level keys (NVDAc):", firstTop, "data keys:", raw.NVDAc?.data ? Object.keys(raw.NVDAc.data) : []);