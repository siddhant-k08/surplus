import { verifyTypedData, getAddress, isAddress } from "viem";

/**
 * Getting a buyer back to what they paid for.
 *
 * The receipt id travels exactly once, in the paid response. A response that never arrives, or a tab
 * closed before the link was saved, leaves someone who has paid with no way to the brief. The one thing
 * they can still prove is the wallet that paid, which the settlement records.
 *
 * An address alone proves nothing: it is public, and anyone watching the seller on Base can read the
 * payers off the chain. So recovery takes a signature from that address over a single-use nonce this
 * server issued, which is the same shape as the owner's sign-in and for the same reason: a captured
 * signature must not be replayable by whoever captured it.
 *
 * What this deliberately does not do is let the owner, or anyone else, recover someone's briefs. The
 * only key is control of the paying wallet.
 */

export const RECOVERY_TYPES = {
    Recover: [
        { name: "statement", type: "string" },
        { name: "address", type: "address" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "uint256" },
    ],
} as const;

export const RECOVERY_STATEMENT =
    "Prove this wallet paid for a Surplus brief, to get your receipt link back. This authorises nothing else.";

export interface RecoveryPayload {
    domain: { name: string; version: string; chainId: number };
    types: typeof RECOVERY_TYPES;
    primaryType: "Recover";
    message: { statement: string; address: `0x${string}`; nonce: string; issuedAt: bigint };
}

/** The exact payload a buyer's wallet signs. */
export function recoveryPayload(args: {
    address: string;
    nonce: string;
    issuedAt: number;
    chainId: number;
}): RecoveryPayload {
    return {
        domain: { name: "Surplus", version: "1", chainId: args.chainId },
        types: RECOVERY_TYPES,
        primaryType: "Recover",
        message: {
            statement: RECOVERY_STATEMENT,
            address: getAddress(args.address),
            nonce: args.nonce,
            issuedAt: BigInt(args.issuedAt),
        },
    };
}

export type RecoveryVerdict = { ok: true; address: `0x${string}` } | { ok: false; reason: string };

/**
 * Checks that the signature really comes from the address it claims.
 *
 * Unlike the owner's sign-in there is no configured address to check against: any buyer may recover
 * their own purchases, so the address comes from the request and the signature is what makes it true.
 * Which receipts that address can see is then decided entirely by what it paid for.
 */
export async function verifyRecovery(args: {
    address: string;
    signature: string;
    nonce: string;
    issuedAt: number;
    chainId: number;
}): Promise<RecoveryVerdict> {
    if (!isAddress(args.address)) return { ok: false, reason: "that is not a valid address" };
    if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
        return { ok: false, reason: "signature must be 65 bytes of hex" };
    }
    const address = getAddress(args.address);
    const payload = recoveryPayload({ address, nonce: args.nonce, issuedAt: args.issuedAt, chainId: args.chainId });
    try {
        const valid = await verifyTypedData({
            address,
            domain: payload.domain,
            types: payload.types,
            primaryType: payload.primaryType,
            message: payload.message,
            signature: args.signature as `0x${string}`,
        });
        // one message for every failure, so a caller learns it failed and nothing about how close it came
        return valid ? { ok: true, address } : { ok: false, reason: "that signature does not match the address" };
    } catch (e) {
        return { ok: false, reason: `signature could not be verified: ${e instanceof Error ? e.message : String(e)}` };
    }
}
