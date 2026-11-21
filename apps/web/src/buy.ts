/**
 * Paying for a brief from the page.
 *
 * Loaded on demand. The x402 and viem packages are most of the bundle, and a visitor reading the
 * storefront should not download a payment stack they may never use.
 *
 * The signer is the visitor's own wallet. `ClientEvmSigner` needs only an address and `signTypedData`,
 * which is exactly what an injected provider gives, so no key ever exists in the page.
 */
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { signTypedData } from "./wallet";

export interface Purchase {
    brief: unknown;
    receipt: { id: string; url: string };
}

/** What the 402 said it wants, so the page can show the price before anyone commits. */
export interface Terms {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
}

export async function readTerms(path: string, init?: RequestInit): Promise<Terms | null> {
    const res = await fetch(path, { ...init, method: init?.method ?? "GET" });
    if (res.status !== 402) return null;
    const header = res.headers.get("payment-required");
    if (header === null) return null;
    const decoded = JSON.parse(atob(header)) as { accepts?: Terms[] };
    return decoded.accepts?.[0] ?? null;
}

/**
 * Buys whatever the given route sells, paying with the visitor's wallet.
 *
 * Any failure is surfaced as-is rather than retried. A payment that failed at settlement must not be
 * silently attempted again: the buyer should see what happened and decide.
 */
export async function buy(args: {
    path: string;
    address: string;
    network: string;
    body?: unknown;
}): Promise<Purchase> {
    const signer = {
        address: args.address as `0x${string}`,
        signTypedData: (message: {
            domain: Record<string, unknown>;
            types: Record<string, unknown>;
            primaryType: string;
            message: Record<string, unknown>;
        }) => signTypedData(args.address, message) as Promise<`0x${string}`>,
    };

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [{ network: args.network as `${string}:${string}`, client: new ExactEvmScheme(signer) }],
    });

    const res = await fetchWithPayment(args.path, {
        method: args.body === undefined ? "GET" : "POST",
        ...(args.body !== undefined && {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args.body),
        }),
    });

    const text = await res.text();
    if (!res.ok) {
        const reason = ((): string => {
            try {
                const o = JSON.parse(text) as { error?: string; details?: string[] };
                return o.error ?? o.details?.join("; ") ?? text;
            } catch {
                return text;
            }
        })();
        throw new Error(describePaymentFailure(res.status, reason));
    }
    return JSON.parse(text) as Purchase;
}

/** Turns a settlement error into something a buyer can act on. */
export function describePaymentFailure(status: number, reason: string): string {
    if (reason.includes("insufficient_balance")) {
        return "Your wallet does not hold enough USDC on this network. Top it up and try again; nothing was charged.";
    }
    if (status === 402) return `The payment was not accepted: ${reason}`;
    if (status === 400) return reason;
    return `The purchase failed (${status}): ${reason}`;
}
