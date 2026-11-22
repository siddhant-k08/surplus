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

/**
 * Shows that the sale landed in the seller's books.
 *
 * This never throws. By the time it runs the money has moved and the brief is in hand, so a failure
 * to read the books is a reporting problem, not a failed purchase, and must not exit non-zero: an
 * operator who sees this script fail will assume the buy failed and try again.
 *
 * `/ledger` is the operator's whole financial history, so it needs the owner token unless the
 * operator opted into PUBLIC_LEDGER. A real buyer has no token and does not need one; the settlement
 * transaction is public on Base and is their proof. Whoever runs this script against their own
 * endpoint does have one.
 */
async function showLedger(url: string, transaction: string | null): Promise<void> {
    console.log("\nSeller ledger after the sale:");
    const token = process.env.OWNER_TOKEN?.trim();
    if (token === undefined || token === "") {
        console.log("  OWNER_TOKEN is not set here, so the books stay closed. That is the endpoint doing its job.");
        if (transaction !== null) console.log(`  The settlement above is public on Base: ${transaction}`);
        return;
    }

    let payload: unknown;
    try {
        const res = await fetch(`${url}/ledger`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) {
            console.log(`  could not read the books: ${res.status} ${(await res.text()).trim().slice(0, 200)}`);
            return;
        }
        payload = await res.json();
    } catch (e: unknown) {
        console.log(`  could not reach the books: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }

    const ledger = payload as {
        mode?: string;
        entries?: { type: string; mode: string; txHash: string | null; lines: { account: string; amount: string }[] }[];
        sales?: { transaction: string; amountUsdcMinor: string; briefId?: string }[];
    };
    const entries = ledger.entries;
    const sales = ledger.sales;
    if (!Array.isArray(entries) || !Array.isArray(sales)) {
        console.log("  the books answered in a shape this script does not know, so nothing is reported rather than guessed");
        return;
    }

    console.log(`  ${entries.length} entries, ${sales.length} sales, mode ${ledger.mode ?? "?"}`);
    for (const e of entries.slice(-3)) {
        const cash = e.lines.find((l) => l.account === "cash.operating");
        console.log(`  ${e.type} [${e.mode}] ${cash ? formatUsdc(BigInt(cash.amount)) + " USDC" : ""} tx ${e.txHash ?? "none"}`);
    }

    // The only sale this run is responsible for is its own. Counting the others would call someone
    // else's purchase proof of this one.
    if (transaction === null) {
        console.log("  no settlement header came back, so this run cannot point at its own sale");
        return;
    }
    const mine = sales.find((s) => s.transaction === transaction);
    if (mine === undefined) {
        console.log(`  this sale is NOT booked yet (tx ${transaction}): check the server log for the settlement verdict`);
        return;
    }
    console.log(`  this sale: booked, ${formatUsdc(BigInt(mine.amountUsdcMinor))} USDC against ${mine.briefId ?? "unattributed"}`);
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
    let transaction: string | null = null;
    if (settled !== null) {
        const decoded = decodePaymentResponseHeader(settled) as { transaction?: unknown };
        console.log("Settlement:", JSON.stringify(decoded, null, 2));
        if (typeof decoded.transaction === "string") transaction = decoded.transaction;
    }

    const body = (await res.json()) as { brief?: { id?: string; themes?: unknown[] }; model?: string };
    const themeCount = body.brief?.themes?.length ?? 0;
    console.log(`\nGot brief ${body.brief?.id ?? "?"} (${themeCount} themes, model ${body.model ?? "?"})`);

    await showLedger(url, transaction);
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
