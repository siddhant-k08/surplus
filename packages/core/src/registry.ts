import type { TokenRecord } from "./tokens";

export interface RegistryEntry {
    symbol: string;
    name: string;
    address: string; // lowercase
}

/**
 * Tokens listed on Base's official stocks page (https://www.base.org/stocks, read 19 Nov 2026).
 * The page says a token that is not on its list was not issued by Coinbase, so this list is the
 * trust anchor. Re-check it against the page before any mainnet use.
 */
export const BASE_REGISTRY: readonly RegistryEntry[] = [
    { symbol: "NVDAc", name: "NVIDIA", address: "0xb20000000000000000000078ee7ce2fe4908108c" },
    { symbol: "METAc", name: "Meta", address: "0xb2000000000000000000008bc8786b856e61707c" },
    { symbol: "AAPLc", name: "Apple", address: "0xb200000000000000000000c2e324d24d7eecd1fb" },
    { symbol: "GOOGLc", name: "Alphabet", address: "0xb2000000000000000000002d0ba3164cc74f58b7" },
    { symbol: "AMZNc", name: "Amazon", address: "0xb200000000000000000000d9192b6b456483c2e8" },
    { symbol: "MSFTc", name: "Microsoft", address: "0xb200000000000000000000ab99cfa739e253872b" },
    { symbol: "MSTRc", name: "Strategy", address: "0xb2000000000000000000004884b426556b92883d" },
    { symbol: "SNDKc", name: "SanDisk", address: "0xb200000000000000000000397293cb8cda9a10c5" },
    { symbol: "SPCXc", name: "SpaceX", address: "0xb2000000000000000000007b9fcbd005511acbd5" },
    { symbol: "TSLAc", name: "Tesla", address: "0xb2000000000000000000001e800a7f5189430cd0" },
];

export interface SymbolMismatch {
    address: string;
    registrySymbol: string;
    apiSymbol: string;
}

export interface CrossCheckResult {
    /** In both the registry and the API with the same symbol. Only these may be traded. */
    trusted: TokenRecord[];
    /** Registry entries the API did not return. */
    missingFromApi: RegistryEntry[];
    /** Returned by the API but not on the registry. Excluded until explained. */
    apiOnly: TokenRecord[];
    symbolMismatch: SymbolMismatch[];
}

export function crossCheck(
    apiTokens: readonly TokenRecord[],
    registry: readonly RegistryEntry[] = BASE_REGISTRY,
): CrossCheckResult {
    const byAddress = new Map(registry.map((r) => [r.address.toLowerCase(), r]));
    const trusted: TokenRecord[] = [];
    const apiOnly: TokenRecord[] = [];
    const symbolMismatch: SymbolMismatch[] = [];
    const seen = new Set<string>();

    for (const t of apiTokens) {
        const entry = byAddress.get(t.address.toLowerCase());
        if (!entry) {
            apiOnly.push(t);
            continue;
        }
        seen.add(entry.address.toLowerCase());
        if (entry.symbol === t.symbol) trusted.push(t);
        else symbolMismatch.push({ address: t.address, registrySymbol: entry.symbol, apiSymbol: t.symbol });
    }

    const missingFromApi = registry.filter((r) => !seen.has(r.address.toLowerCase()));
    return { trusted, missingFromApi, apiOnly, symbolMismatch };
}