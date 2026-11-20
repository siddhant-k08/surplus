/**
 * Buys one brief from the running endpoint, to prove the paid path end to end.
 *
 * The buyer key is read from `.env` as X402_BUYER_PRIVATE_KEY and is never printed. Use a throwaway
 * testnet wallet only. This script moves testnet USDC; it is not for mainnet.
 */
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { formatUsdc } from "@surplus/core";
import { BASE_SEPOLIA, BASE_MAINNET, type CaipNetwork } from "./config";
import { loadRootEnv } from "./paths";

loadRootEnv();

function buyerAccount() {
    const key = process.env.X402_BUYER_PRIVATE_KEY?.trim();
    if (key === undefined || key === "") {
        throw new Error("X402_BUYER_PRIVATE_KEY is not set in the repo root .env. Use a throwaway testnet key.");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("X402_BUYER_PRIVATE_KEY must be a 0x-prefixed 32 byte hex key");
    }
    return privateKeyToAccount(key as `0x${string}`);
}

async function main(): Promise<void> {
    const url = (process.env.X402_API_URL ?? "http://localhost:4021").trim();
    const raw = (process.env.X402_NETWORK ?? BASE_SEPOLIA).trim();
    if (raw !== BASE_SEPOLIA && raw !== BASE_MAINNET) throw new Error(`unknown X402_NETWORK ${raw}`);
    const network: CaipNetwork = raw;
    if (network === BASE_MAINNET && process.env.MAINNET_ENABLED !== "true") {
        throw new Error("Refusing to spend on Base mainnet: set MAINNET_ENABLED=true to authorize it");
    }

    const account = buyerAccount();
    console.log(`Buyer ${account.address} on ${network}`);

    // what the seller is asking, before paying anything
    const probe = await fetch(`${url}/brief`);
    if (probe.status !== 402) {
        throw new Error(`expected 402 from ${url}/brief, got ${probe.status}. Is the endpoint running?`);
    }
    const challenge = probe.headers.get("payment-required");
    if (challenge !== null) {
        const decoded: unknown = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
        console.log("Challenge:", JSON.stringify(decoded, null, 2));
    }

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [{ network, client: new ExactEvmScheme(account) }],
    });

    console.log("\nPaying and fetching...");
    const res = await fetchWithPayment(`${url}/brief`, { method: "GET" });
    if (!res.ok) throw new Error(`paid request failed: ${res.status} ${await res.text()}`);

    const settled = res.headers.get("payment-response");
    if (settled !== null) {
        console.log("Settlement:", JSON.stringify(decodePaymentResponseHeader(settled), null, 2));
    }

    const body = (await res.json()) as { brief?: { id?: string; themes?: unknown[] }; model?: string };
    const themeCount = body.brief?.themes?.length ?? 0;
    console.log(`\nGot brief ${body.brief?.id ?? "?"} (${themeCount} themes, model ${body.model ?? "?"})`);

    const ledger = (await (await fetch(`${url}/ledger`)).json()) as {
        entries: { type: string; mode: string; txHash: string | null; lines: { account: string; amount: string }[] }[];
        sales: { transaction: string; amountUsdcMinor: string }[];
    };
    console.log("\nSeller ledger after the sale:");
    for (const e of ledger.entries) {
        const cash = e.lines.find((l) => l.account === "cash.operating");
        console.log(`  ${e.type} [${e.mode}] ${cash ? formatUsdc(BigInt(cash.amount)) + " USDC" : ""} tx ${e.txHash ?? "none"}`);
    }
    for (const s of ledger.sales) {
        console.log(`  sale ${formatUsdc(BigInt(s.amountUsdcMinor))} USDC, tx ${s.transaction}`);
    }
    if (ledger.sales.length === 0) console.log("  no sale booked: check the server log for the settlement verdict");
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
