/**
 * Where to look a settlement up, given the network it settled on.
 *
 * A transaction hash is meaningless without its chain, and showing one against the wrong explorer is
 * worse than showing no link: the page would be pointing confidently at a transaction that is not the
 * buyer's. So this answers null for anything it does not know, including the receipts written before
 * the network was recorded, and the page says the hash without linking it.
 *
 * Never falls back to the network this page happens to be configured for. That value describes the
 * server today, not where an old sale settled.
 */
const EXPLORERS: Record<string, { name: string; tx: string }> = {
    "eip155:8453": { name: "BaseScan", tx: "https://basescan.org/tx/" },
    "eip155:84532": { name: "BaseScan Sepolia", tx: "https://sepolia.basescan.org/tx/" },
};

export interface ExplorerLink {
    name: string;
    url: string;
}

export function explorerTx(network: string | null | undefined, transaction: string): ExplorerLink | null {
    if (typeof network !== "string" || network === "") return null;
    if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) return null;
    const known = EXPLORERS[network.trim()];
    return known === undefined ? null : { name: known.name, url: `${known.tx}${transaction}` };
}

/** Where to see one wallet's balance of one token, or null for a chain this does not know. */
export function explorerTokenBalance(network: string, token: string, holder: string): ExplorerLink | null {
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(holder)) return null;
    const known = EXPLORERS[network.trim()];
    if (known === undefined) return null;
    return { name: known.name, url: `${known.tx.replace(/\/tx\/$/, "/token/")}${token}?a=${holder}` };
}

/** A hash shortened for display. The full value stays in the link and the title attribute. */
export function shortHash(hash: string, lead = 10, tail = 6): string {
    return hash.length <= lead + tail + 1 ? hash : `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

/** A readable name for a CAIP-2 network, for the cases where there is no explorer to link to. */
export function networkName(network: string | null | undefined): string | null {
    if (typeof network !== "string" || network === "") return null;
    const known: Record<string, string> = { "eip155:8453": "Base", "eip155:84532": "Base Sepolia" };
    return known[network.trim()] ?? network.trim();
}
