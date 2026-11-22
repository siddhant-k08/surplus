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
import { recoverTypedDataAddress } from "viem";
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
/** The EIP-3009 authorisation a payment signature covers, as it reaches the signer. */
interface Authorization {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, string>;
}

/**
 * Checks a payment signature against the authorisation it is supposed to cover, before sending it.
 *
 * The facilitator answers a mismatch with `invalid_exact_evm_signature`, which says that something is
 * wrong without saying what, and is indistinguishable from a bug in our own serialisation. Everything
 * needed to tell those apart is already here: recover the signer and compare it to the account the
 * payment pays from.
 *
 * Two real causes this names. A wallet holding several accounts can sign with a different one than it
 * offered, which is easy to do after importing a key. And a second wallet extension can answer the
 * request that the first one was asked, so the account offered and the account signing come from
 * different wallets entirely.
 *
 * The expiry check is here for the same reason: an authorisation is valid for a few minutes, so a
 * prompt left sitting produces a signature the facilitator will refuse, and "you took too long" is a
 * thing a person can act on.
 */
export async function checkPaymentSignature(td: Authorization, signature: string, offered: string): Promise<void> {
    const from = td.message.from;
    const fields = td.types[td.primaryType];
    if (from === undefined || fields === undefined) return; // not an authorisation we know how to check

    const validBefore = Number(td.message.validBefore);
    if (Number.isFinite(validBefore) && validBefore * 1000 < Date.now()) {
        throw new Error(
            "This payment expired while it waited to be approved. Nothing was charged. Buy again and " +
            "confirm in your wallet within a few minutes.",
        );
    }

    const signer = await recoverTypedDataAddress({
        domain: td.domain,
        types: { [td.primaryType]: fields },
        primaryType: td.primaryType,
        message: td.message,
        signature: signature as `0x${string}`,
    } as never);

    if (signer.toLowerCase() !== from.toLowerCase()) {
        throw new Error(
            `Your wallet signed as ${signer} but the payment pays from ${from}` +
            (offered.toLowerCase() === from.toLowerCase() ? "" : ` (it offered ${offered})`) +
            ". Nothing was charged. Select that account in your wallet, or disable any second wallet " +
            "extension, and buy again.",
        );
    }
}

export async function buy(args: {
    path: string;
    address: string;
    network: string;
    body?: unknown;
}): Promise<Purchase> {
    const signer = {
        address: args.address as `0x${string}`,
        signTypedData: async (message: Authorization): Promise<`0x${string}`> => {
            const signature = (await signTypedData(args.address, message)) as `0x${string}`;
            // checked here rather than after the rejection, so a doomed payment is never sent
            await checkPaymentSignature(message, signature, args.address);
            return signature;
        },
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
    // A timeout is the one failure that must not end with "try again". The payment service stopped
    // answering, and from here there is no way to know whether it stopped before or after taking the
    // money: a settlement that already happened is onchain whatever this page was told. So the buyer is
    // pointed at their receipts rather than at the button that would charge them a second time.
    if (reason.includes("timed out")) {
        return (
            "The payment service stopped answering, so this purchase has no verdict. Your payment may " +
            "still have gone through. Check \u201cLost your link?\u201d below with the same wallet before " +
            "buying again, so you do not pay twice."
        );
    }
    if (reason.includes("invalid_exact_evm_signature")) {
        return (
            "The payment service rejected the signature, and nothing was charged. The usual cause is a " +
            "wallet signing from a different account than the one it offered, or a second wallet " +
            "extension answering instead. Check which account is selected and buy again."
        );
    }
    if (status === 402) return `The payment was not accepted: ${reason}`;
    if (status === 400) return reason;
    return `The purchase failed (${status}): ${reason}`;
}
