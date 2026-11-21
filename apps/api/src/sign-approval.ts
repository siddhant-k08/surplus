/**
 * Signs an approval the owner was offered, then posts it.
 *
 * The owner key is read from `.env` as OWNER_PRIVATE_KEY and is never printed. Use a throwaway wallet.
 * This is the stand-in for a real wallet UI: it proves the signed path end to end from the command line.
 *
 * Usage: npm run approve -w @surplus/api -- <proposalId>
 */
import { privateKeyToAccount } from "viem/accounts";
import { APPROVAL_TYPES } from "@surplus/core";
import { loadRootEnv } from "./paths";

loadRootEnv();

function ownerAccount() {
    const key = process.env.OWNER_PRIVATE_KEY?.trim();
    if (key === undefined || key === "") {
        throw new Error("OWNER_PRIVATE_KEY is not set in the repo root .env. Use a throwaway key.");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("OWNER_PRIVATE_KEY must be a 0x-prefixed 32 byte hex key");
    return privateKeyToAccount(key as `0x${string}`);
}

interface OfferedTypedData {
    domain: { name: string; version: string; chainId: number };
    message: { proposalHash: string; mandateVersion: string; mandateHash: string; maxUsdcIn: string; expiresAt: string };
}

async function main(): Promise<void> {
    const id = process.argv[2];
    if (id === undefined || id === "") throw new Error("usage: npm run approve -w @surplus/api -- <proposalId>");

    const url = (process.env.X402_API_URL ?? "http://localhost:4021").trim();
    const token = process.env.OWNER_TOKEN?.trim();
    if (token === undefined || token === "") throw new Error("OWNER_TOKEN is not set in .env");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const account = ownerAccount();
    console.log(`Owner ${account.address}`);

    // propose, which returns the exact payload to sign
    const proposed = await fetch(`${url}/invest/propose`, { method: "POST", headers, body: JSON.stringify({ id }) });
    const body = (await proposed.json()) as { toSign?: OfferedTypedData; refused?: string[]; totalUsdcIn?: string };
    if (!proposed.ok || body.toSign === undefined) {
        throw new Error(`propose failed (${proposed.status}): ${JSON.stringify(body.refused ?? body)}`);
    }
    const td = body.toSign;
    console.log(`Proposal ${id} totals ${body.totalUsdcIn} USDC minor units`);
    console.log(`Signing for chain ${td.domain.chainId}, ceiling ${td.message.maxUsdcIn}, expires ${new Date(Number(td.message.expiresAt) * 1000).toISOString()}`);

    const signature = await account.signTypedData({
        domain: td.domain,
        types: APPROVAL_TYPES,
        primaryType: "Approval",
        message: {
            proposalHash: td.message.proposalHash as `0x${string}`,
            mandateVersion: BigInt(td.message.mandateVersion),
            mandateHash: td.message.mandateHash as `0x${string}`,
            maxUsdcIn: BigInt(td.message.maxUsdcIn),
            expiresAt: BigInt(td.message.expiresAt),
        },
    });

    const approved = await fetch(`${url}/invest/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id, signature }),
    });
    const result = (await approved.json()) as unknown;
    console.log(`approve -> ${approved.status}`, JSON.stringify(result));
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
