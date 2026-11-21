import { verifyTypedData, isAddress, getAddress } from "viem";
import { approvalTypedData, type Approval } from "@surplus/core";

/** Why an approval signature was or was not accepted. */
export type SignatureVerdict =
    | { ok: true; signer: `0x${string}` }
    | { ok: false; reason: string };

/**
 * Checks that an approval was signed by the owner.
 *
 * The owner's address comes from configuration, never from the request: a caller supplying the address it
 * signed with would be authorizing itself. The typed data is rebuilt here from the approval the agent
 * computed, so the signature is checked against what the agent will actually execute rather than against
 * anything the caller sent.
 *
 * `verifyTypedData` handles both EOA signatures and ERC-1271 contract wallets when given a client; with no
 * client it recovers an EOA signature, which is what a throwaway owner wallet produces.
 */
export async function verifyApprovalSignature(args: {
    approval: Approval;
    chainId: number;
    signature: string;
    ownerAddress: string;
}): Promise<SignatureVerdict> {
    const { approval, chainId, signature, ownerAddress } = args;

    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return { ok: false, reason: "signature must be 65 bytes of hex (0x followed by 130 characters)" };
    }
    if (!isAddress(ownerAddress)) return { ok: false, reason: "the configured owner address is not valid" };

    const owner = getAddress(ownerAddress);
    const td = approvalTypedData(approval, chainId);

    let valid: boolean;
    try {
        valid = await verifyTypedData({
            address: owner,
            domain: td.domain,
            types: td.types,
            primaryType: td.primaryType,
            message: td.message,
            signature: signature as `0x${string}`,
        });
    } catch (e) {
        return { ok: false, reason: `signature could not be verified: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (!valid) {
        // deliberately vague: the caller learns it failed, not how close it came
        return { ok: false, reason: "signature is not a valid owner approval of this proposal" };
    }
    return { ok: true, signer: owner };
}
