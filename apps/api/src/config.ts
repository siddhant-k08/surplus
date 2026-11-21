import { parseUsdc, type Mode } from "@surplus/core";
import { fromRepoRoot, REPO_ROOT } from "./paths";

/** CAIP-2 network ids. The free x402.org facilitator serves Base Sepolia only (checked 21 Nov 2026). */
export const BASE_SEPOLIA = "eip155:84532" as const;
export const BASE_MAINNET = "eip155:8453" as const;

/** Matches the SDK's `Network` type, which is a CAIP-2 string. */
export type CaipNetwork = typeof BASE_SEPOLIA | typeof BASE_MAINNET;

/**
 * USDC per network, from Circle's contract address list (read 21 Nov 2026). The mainnet value matches the
 * address already verified in docs/HANDOFF.md, which is what makes the testnet one credible too.
 */
export const USDC: Record<string, string> = {
    [BASE_SEPOLIA]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    [BASE_MAINNET]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export interface ApiConfig {
    port: number;
    network: CaipNetwork;
    facilitatorUrl: string;
    payTo: string;
    priceUsd: string;
    /** The owner's catalogue, served by GET /brief and used by the investing loop. */
    briefsDir: string;
    /**
     * Buyer-commissioned briefs, kept apart from the catalogue.
     *
     * One directory for both would mean the cheap cached route served whatever a buyer just paid the
     * premium price to have generated, and the investing loop would try to fund a buyer's own themes.
     */
    customBriefsDir: string;
    /** The asset the settled amount must be denominated in before any revenue is booked. */
    expectedAsset: string;
    /** Append-only JSONL file the ledger is persisted to. */
    ledgerPath: string;
    /** Where the investing book lives. Separate from the sales book so simulated fills never mix in. */
    investLedgerPath: string;
    /** Mode of the investing book. `sim` while fills are simulated. */
    investMode: Mode;
    /** Whether the session cookie is marked Secure. Off for plain-http localhost, on anywhere real. */
    cookieSecure: boolean;
    /** Shared secret for the owner routes. Decides who may reach them, not what is authorized. */
    ownerToken: string;
    /** The address whose EIP-712 signature authorizes an approval. */
    ownerAddress: string;
    /** Chain id bound into the signed approval domain. */
    approvalChainId: number;
    /** Append-only JSONL file the owner's mandate history lives in. */
    mandatePath: string;
    /** Append-only JSONL file of what each buyer may come back to. */
    receiptsPath: string;
    /**
     * Postgres connection string, or empty to keep the books in the JSONL files.
     *
     * Not a performance choice. The ledger, the mandate history, the receipts and a buyer's
     * commissioned brief are all written while the agent runs, so a host that can replace the process
     * (and its filesystem) between two requests needs a database or it loses settlements that really
     * happened and resets the owner's constraints without saying so.
     */
    databaseUrl: string;
    /**
     * Whether GET /ledger is public.
     *
     * The sales book carries every transaction hash, amount and brief sold, which is the operator's full
     * financial history. Transparency to a buyer is a deliberate choice, not a default.
     */
    publicLedger: boolean;
    /** Owner-provided working capital for the investing book, in USDC minor units. */
    openingFloatUsdcMinor: bigint;
    /** Price of an on-demand brief generated for the buyer's own themes. */
    researchPriceUsd: string;
    /** Hard cap on what one generated brief may cost. Never above the research price. */
    researchMaxUsd: number;
    /** A cached brief for the same themes younger than this is served instead of generating again. */
    briefMaxAgeSeconds: number;
    /** Ceiling on total research spend for the life of this process. */
    researchTotalMaxUsd: number;
    /** Ledger mode tag. Never "sim": money really moves on a testnet. */
    mode: Mode;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const v = env[name];
    if (v === undefined || v.trim() === "") {
        // Name where it was looked for: npm runs a workspace script from apps/api, and a .env that was
        // never loaded looks exactly like a value that was never set.
        throw new Error(`${name} is not set. Looked in the environment and in ${REPO_ROOT}/.env`);
    }
    return v.trim();
}

/**
 * Reads the config and refuses anything unsafe before the server can start.
 *
 * Mainnet is off unless MAINNET_ENABLED is exactly "true", matching the project rule that mainnet stays
 * off until explicitly authorized. An unknown network is refused outright rather than defaulted.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
    const raw = (env.X402_NETWORK ?? BASE_SEPOLIA).trim();
    if (raw !== BASE_SEPOLIA && raw !== BASE_MAINNET) {
        throw new Error(`X402_NETWORK must be ${BASE_SEPOLIA} (Base Sepolia) or ${BASE_MAINNET} (Base mainnet), got ${raw}`);
    }
    const network: CaipNetwork = raw;
    if (network === BASE_MAINNET && env.MAINNET_ENABLED !== "true") {
        throw new Error("Refusing to serve on Base mainnet: set MAINNET_ENABLED=true to authorize it");
    }

    const payTo = required(env, "X402_PAY_TO");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("X402_PAY_TO must be a 20 byte hex address");

    const priceUsd = (env.BRIEF_PRICE_USD ?? "$0.01").trim();
    if (!/^\$\d+(\.\d{1,6})?$/.test(priceUsd)) throw new Error(`BRIEF_PRICE_USD must look like "$3.00", got ${priceUsd}`);

    const portRaw = (env.PORT ?? "4021").trim();
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a valid port, got ${portRaw}`);

    const expectedAsset = (env.X402_EXPECTED_ASSET ?? USDC[network] ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(expectedAsset)) throw new Error("X402_EXPECTED_ASSET must be a 20 byte hex address");

    // Fills are simulated until mainnet investing is explicitly authorized. The investing book's mode says
    // which it is, so a reader never has to guess whether a position was really bought.
    const investRaw = (env.INVEST_MODE ?? "sim").trim();
    if (investRaw !== "sim" && investRaw !== "testnet" && investRaw !== "mainnet") {
        throw new Error(`INVEST_MODE must be sim, testnet or mainnet, got ${investRaw}`);
    }
    if (investRaw === "mainnet" && env.MAINNET_ENABLED !== "true") {
        throw new Error("Refusing to invest on mainnet: set MAINNET_ENABLED=true to authorize it");
    }
    const investMode: Mode = investRaw;

    // Model costs are paid before any revenue arrives, so the investing book needs the owner's working
    // capital on record; without it operating cash goes negative and reconciliation rightly objects.
    const floatRaw = (env.OPENING_FLOAT_USDC ?? "1.00").trim();
    if (!/^\d+(\.\d{1,6})?$/.test(floatRaw)) {
        throw new Error(`OPENING_FLOAT_USDC must be a plain amount like "1.00", got ${floatRaw}`);
    }
    const openingFloat = parseUsdc(floatRaw);

    // On-demand research costs real money per request, so the price must cover the cap. Refusing at startup
    // is the only place this can be caught before a buyer has already paid for a brief sold at a loss.
    const researchPriceUsd = (env.RESEARCH_PRICE_USD ?? "$2.00").trim();
    if (!/^\$\d+(\.\d{1,6})?$/.test(researchPriceUsd)) {
        throw new Error(`RESEARCH_PRICE_USD must look like "$2.00", got ${researchPriceUsd}`);
    }
    const researchMaxRaw = (env.RESEARCH_MAX_USD ?? "1.50").trim();
    const researchMaxUsd = Number(researchMaxRaw);
    if (!Number.isFinite(researchMaxUsd) || researchMaxUsd <= 0) {
        throw new Error(`RESEARCH_MAX_USD must be a positive number, got ${researchMaxRaw}`);
    }
    if (researchMaxUsd > Number(researchPriceUsd.slice(1))) {
        throw new Error(
            `RESEARCH_MAX_USD (${researchMaxUsd}) must not exceed RESEARCH_PRICE_USD (${researchPriceUsd}): ` +
            "a generated brief must never be able to cost more than the buyer paid",
        );
    }

    const totalRaw = (env.RESEARCH_TOTAL_MAX_USD ?? "10.00").trim();
    const researchTotalMaxUsd = Number(totalRaw);
    if (!Number.isFinite(researchTotalMaxUsd) || researchTotalMaxUsd < researchMaxUsd) {
        throw new Error(
            `RESEARCH_TOTAL_MAX_USD must be a number at least RESEARCH_MAX_USD (${researchMaxUsd}), got ${totalRaw}`,
        );
    }

    const ageRaw = (env.BRIEF_MAX_AGE_SECONDS ?? "86400").trim();
    const briefMaxAgeSeconds = Number(ageRaw);
    if (!Number.isInteger(briefMaxAgeSeconds) || briefMaxAgeSeconds < 0) {
        throw new Error(`BRIEF_MAX_AGE_SECONDS must be a non-negative integer, got ${ageRaw}`);
    }

    // Approvals are authorized by the owner's signature, so the address is required: without it there is
    // no way to tell an owner's approval from anyone else's, and the server must not start half-secured.
    const ownerAddress = (env.OWNER_ADDRESS ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
        throw new Error("OWNER_ADDRESS must be the 20 byte hex address whose signature approves trades");
    }
    // Defaults to the network being sold on, so a signature is bound to the chain actually in use.
    const chainRaw = (env.APPROVAL_CHAIN_ID ?? (network === BASE_MAINNET ? "8453" : "84532")).trim();
    const approvalChainId = Number(chainRaw);
    if (!Number.isInteger(approvalChainId) || approvalChainId <= 0) {
        throw new Error(`APPROVAL_CHAIN_ID must be a positive integer, got ${chainRaw}`);
    }

    // A Secure cookie is never sent over plain http, so local development would silently fail to sign in.
    // Default on, off only when explicitly developing against http.
    const cookieSecure = (env.COOKIE_SECURE ?? "true").trim() !== "false";

    // The owner routes move money, so there is no default and no open mode: an unset token is a refusal.
    const ownerToken = (env.OWNER_TOKEN ?? "").trim();
    if (ownerToken.length < 16) {
        throw new Error("OWNER_TOKEN must be set to at least 16 characters; the owner routes propose, approve and execute trades");
    }

    return {
        port,
        network,
        facilitatorUrl: (env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator").trim(),
        payTo,
        priceUsd,
        briefsDir: fromRepoRoot((env.BRIEFS_DIR ?? "docs/briefs").trim()),
        customBriefsDir: fromRepoRoot((env.CUSTOM_BRIEFS_DIR ?? "data/briefs-custom").trim()),
        // one file per mode: a testnet ledger and a mainnet ledger must never share a file
        ledgerPath: fromRepoRoot((env.LEDGER_PATH ?? `data/ledger-${network === BASE_MAINNET ? "mainnet" : "testnet"}.jsonl`).trim()),
        investLedgerPath: fromRepoRoot((env.INVEST_LEDGER_PATH ?? `data/ledger-invest-${investMode}.jsonl`).trim()),
        investMode,
        ownerAddress,
        approvalChainId,
        cookieSecure,
        publicLedger: (env.PUBLIC_LEDGER ?? "false").trim() === "true",
        mandatePath: fromRepoRoot((env.MANDATE_PATH ?? "data/mandate.jsonl").trim()),
        receiptsPath: fromRepoRoot((env.RECEIPTS_PATH ?? "data/receipts.jsonl").trim()),
        databaseUrl: (env.DATABASE_URL ?? "").trim(),
        ownerToken,
        openingFloatUsdcMinor: openingFloat,
        researchPriceUsd,
        researchMaxUsd,
        researchTotalMaxUsd,
        briefMaxAgeSeconds,
        expectedAsset,
        mode: network === BASE_MAINNET ? "mainnet" : "testnet",
    };
}
