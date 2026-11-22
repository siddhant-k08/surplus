import type { Approval } from "./approval";

/**
 * EIP-712 typed data for an owner's approval of one proposal.
 *
 * This module is deliberately free of crypto dependencies: it only builds the exact structure that gets
 * signed and verified, so the agent, the owner's wallet and any reviewer can all derive the same bytes.
 * Signing and recovery live in the app layer.
 *
 * What the signature binds, and why each field has to be in it:
 *
 * - `proposalHash` ties the signature to one set of legs. Moving it to a different proposal fails.
 * - `mandateVersion` and `mandateHash` tie it to the constraints in force. Changing the mandate invalidates
 *   every outstanding approval, which is what forces reapproval.
 * - `maxUsdcIn` is the ceiling the owner agreed to spend, so a larger execution cannot reuse the signature.
 * - `expiresAt` bounds the window, so a stale signature cannot be replayed later.
 * - `chainId` in the domain stops a signature made for a testnet from being valid on mainnet.
 *
 * A proposal can only be approved from the PROPOSED state, so a signature is single use within the agent.
 */

export const APPROVAL_DOMAIN_NAME = "Surplus";
export const APPROVAL_DOMAIN_VERSION = "1";

/**
 * The EIP-712 domain type, for the payload that crosses the wire to a wallet.
 *
 * `eth_signTypedData_v4` expects the domain's own type to be declared in `types`. viem infers it from
 * the domain's fields, so the server never needs it and the hash is identical either way (a test pins
 * that). A browser wallet is not viem: one that has to guess this is one that can guess differently,
 * and the failure arrives as a signature the server rejects for no visible reason.
 *
 * The fields here must stay exactly the fields of `ApprovalDomain` and the login domain, in order.
 */
export const EIP712_DOMAIN_TYPE = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
] as const;

export const APPROVAL_TYPES = {
    Approval: [
        { name: "proposalHash", type: "bytes32" },
        { name: "mandateVersion", type: "uint256" },
        { name: "mandateHash", type: "bytes32" },
        { name: "maxUsdcIn", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
    ],
} as const;

export const APPROVAL_PRIMARY_TYPE = "Approval";

export interface ApprovalDomain {
    name: string;
    version: string;
    chainId: number;
}

export interface ApprovalMessage {
    proposalHash: `0x${string}`;
    mandateVersion: bigint;
    mandateHash: `0x${string}`;
    maxUsdcIn: bigint;
    /** Unix seconds, so the message holds no ambiguity about format or timezone. */
    expiresAt: bigint;
}

export interface ApprovalTypedData {
    domain: ApprovalDomain;
    types: typeof APPROVAL_TYPES;
    primaryType: typeof APPROVAL_PRIMARY_TYPE;
    message: ApprovalMessage;
}

const hex32 = (s: string): `0x${string}` => {
    const bare = s.startsWith("0x") ? s.slice(2) : s;
    if (!/^[0-9a-fA-F]{64}$/.test(bare)) throw new Error(`expected a 32 byte hex hash, got ${s}`);
    return `0x${bare.toLowerCase()}`;
};

export const approvalDomain = (chainId: number): ApprovalDomain => {
    if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`chainId must be a positive integer, got ${chainId}`);
    return { name: APPROVAL_DOMAIN_NAME, version: APPROVAL_DOMAIN_VERSION, chainId };
};

/** The message an owner signs. Timestamps become unix seconds; hashes become 32 byte hex. */
export function approvalMessage(a: Approval): ApprovalMessage {
    const ms = Date.parse(a.expiresAt);
    if (Number.isNaN(ms)) throw new Error(`approval expiresAt is not a date: ${a.expiresAt}`);
    if (!Number.isInteger(a.mandateVersion) || a.mandateVersion < 1) {
        throw new Error(`mandateVersion must be a positive integer, got ${a.mandateVersion}`);
    }
    if (a.maxUsdcIn < 0n) throw new Error("maxUsdcIn must not be negative");
    return {
        proposalHash: hex32(a.proposalHash),
        mandateVersion: BigInt(a.mandateVersion),
        mandateHash: hex32(a.mandateHash),
        maxUsdcIn: a.maxUsdcIn,
        // seconds, floored: a signature must not depend on sub-second precision surviving a round trip
        expiresAt: BigInt(Math.floor(ms / 1000)),
    };
}

/** The complete typed data payload for one approval. */
export function approvalTypedData(a: Approval, chainId: number): ApprovalTypedData {
    return {
        domain: approvalDomain(chainId),
        types: APPROVAL_TYPES,
        primaryType: APPROVAL_PRIMARY_TYPE,
        message: approvalMessage(a),
    };
}

/** JSON-safe form, for handing to a wallet or printing. Bigints become decimal strings. */
export function approvalTypedDataJson(a: Approval, chainId: number): unknown {
    const td = approvalTypedData(a, chainId);
    return {
        domain: td.domain,
        types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...td.types },
        primaryType: td.primaryType,
        message: {
            proposalHash: td.message.proposalHash,
            mandateVersion: td.message.mandateVersion.toString(),
            mandateHash: td.message.mandateHash,
            maxUsdcIn: td.message.maxUsdcIn.toString(),
            expiresAt: td.message.expiresAt.toString(),
        },
    };
}
