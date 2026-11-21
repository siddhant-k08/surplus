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
    if (code === 4001) return "You rejected the signature in your wallet. Nothing was sent.";
    if (code === -32002) return "Your wallet already has a request open. Finish it there, then try again.";
    if (e instanceof WalletError) return e.message;
    return e instanceof Error ? e.message : String(e);
}
