/**
 * The owner's wallet.
 *
 * Deliberately thin: the desk needs an address and the ability to sign typed data, which is exactly the
 * interface an injected provider gives and exactly what the x402 client wanted too. No wallet library,
 * no connector registry, no chain switching beyond asking.
 */

interface Eip1193Provider {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
    interface Window {
        ethereum?: Eip1193Provider;
    }
}

export class WalletError extends Error {}

export const hasWallet = (): boolean => typeof window !== "undefined" && window.ethereum !== undefined;

function provider(): Eip1193Provider {
    const p = window.ethereum;
    if (p === undefined) {
        throw new WalletError("No browser wallet found. Install one, or use the owner token from a script.");
    }
    return p;
}

/** Asks the wallet to connect and returns the account it offers. */
export async function connect(): Promise<string> {
    const accounts = (await provider().request({ method: "eth_requestAccounts" })) as string[];
    const first = accounts[0];
    if (first === undefined) throw new WalletError("The wallet connected but offered no account.");
    return first;
}

/** The account already connected, if any. Never prompts. */
export async function currentAccount(): Promise<string | null> {
    if (!hasWallet()) return null;
    try {
        const accounts = (await provider().request({ method: "eth_accounts" })) as string[];
        return accounts[0] ?? null;
    } catch {
        return null;
    }
}

export async function chainId(): Promise<number> {
    const hex = (await provider().request({ method: "eth_chainId" })) as string;
    return Number.parseInt(hex, 16);
}

/** The chains this app can ask a wallet to switch to, with what a wallet needs to add an unknown one. */
const CHAINS: Record<number, {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
}> = {
    84532: {
        chainId: "0x14a34",
        chainName: "Base Sepolia",
        rpcUrls: ["https://sepolia.base.org"],
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: ["https://sepolia.basescan.org"],
    },
    8453: {
        chainId: "0x2105",
        chainName: "Base",
        rpcUrls: ["https://mainnet.base.org"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        blockExplorerUrls: ["https://basescan.org"],
    },
};

/** The chain id out of a CAIP-2 string like `eip155:84532`. */
export function chainIdFromCaip(network: string): number | null {
    const match = /^eip155:(\d+)$/.exec(network.trim());
    return match === null ? null : Number(match[1]);
}

/**
 * Puts the wallet on the chain the payment needs, asking before anything is signed.
 *
 * Without this the first thing a buyer meets is a failure they cannot read: the payment is denominated
 * in USDC on one chain and their wallet is pointed at another, so the signature is either refused or
 * settles against nothing. A wallet that has never seen the chain is offered it rather than left stuck.
 */
export async function ensureChain(wanted: number): Promise<void> {
    if (await chainId() === wanted) return;
    const chain = CHAINS[wanted];
    if (chain === undefined) {
        throw new WalletError(`This payment needs chain ${wanted}. Switch your wallet to it and try again.`);
    }
    try {
        await provider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.chainId }] });
    } catch (e) {
        // 4902: the wallet does not know this chain yet, so offer it rather than leaving a dead end
        if ((e as { code?: number }).code !== 4902) throw e;
        await provider().request({ method: "wallet_addEthereumChain", params: [chain] });
    }
    if (await chainId() !== wanted) {
        throw new WalletError(`Your wallet is still not on ${chain.chainName}. Switch it there and try again.`);
    }
}

/**
 * Signs an EIP-712 payload exactly as the server offered it.
 *
 * The payload is passed through untouched. Rebuilding it here would be a second implementation of the
 * thing the signature is supposed to pin down, and any drift between the two would show up as a
 * signature the server rejects for no visible reason.
 */
export async function signTypedData(address: string, payload: unknown): Promise<string> {
    const signature = await provider().request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(payload)],
    });
    if (typeof signature !== "string") throw new WalletError("The wallet returned no signature.");
    return signature;
}

/** Turns a wallet rejection into something worth showing a person. */
export function describeWalletError(e: unknown): string {
    const code = (e as { code?: number })?.code;
    if (code === 4001) return "You rejected the request in your wallet. Nothing was sent and nothing was charged.";
    if (code === -32002) return "Your wallet already has a request open. Finish it there, then try again.";
    if (e instanceof WalletError) return e.message;
    return e instanceof Error ? e.message : String(e);
}
