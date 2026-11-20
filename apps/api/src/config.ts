import type { Mode } from "@surplus/core";

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
    briefsDir: string;
    /** The asset the settled amount must be denominated in before any revenue is booked. */
    expectedAsset: string;
    /** Ledger mode tag. Never "sim": money really moves on a testnet. */
    mode: Mode;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const v = env[name];
    if (v === undefined || v.trim() === "") throw new Error(`${name} is not set`);
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

    const priceUsd = (env.BRIEF_PRICE_USD ?? "$3.00").trim();
    if (!/^\$\d+(\.\d{1,6})?$/.test(priceUsd)) throw new Error(`BRIEF_PRICE_USD must look like "$3.00", got ${priceUsd}`);

    const portRaw = (env.PORT ?? "4021").trim();
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a valid port, got ${portRaw}`);

    const expectedAsset = (env.X402_EXPECTED_ASSET ?? USDC[network] ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(expectedAsset)) throw new Error("X402_EXPECTED_ASSET must be a 20 byte hex address");

    return {
        port,
        network,
        facilitatorUrl: (env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator").trim(),
        payTo,
        priceUsd,
        briefsDir: (env.BRIEFS_DIR ?? "docs/briefs").trim(),
        expectedAsset,
        mode: network === BASE_MAINNET ? "mainnet" : "testnet",
    };
}
