import { erc20Abi } from "viem";
import { getAccount, readContract, signTypedData as wagmiSignTypedData, switchChain } from "wagmi/actions";
import { config } from "./wagmi";

/**
 * The wallet, as the rest of the app sees it.
 *
 * A thin imperative face over wagmi, kept because most of this app is not a React component: the
 * x402 payment stack wants a `signTypedData(address, payload)` it can call, and so do the sign-in and
 * receipt-recovery flows. Everything here goes through the same wagmi store the hooks read, so there
 * is exactly one answer to "which wallet is connected" no matter who asks.
 *
 * Connecting is deliberately not here. It is one button and one modal, OnchainKit's, mounted in
 * `Connect.tsx`; a second way to connect would be a second way for the page and the wallet to
 * disagree about who is signed in, which is the bug this whole layer exists to prevent.
 */

export class WalletError extends Error {}

/** Coinbase Wallet covers extension, mobile and a Smart Wallet passkey; injected is what is installed. */
export type WalletKind = "coinbase" | "injected";

/** The account already connected, if any. Never prompts. */
export function currentAccount(): string | null {
    return getAccount(config).address ?? null;
}

export function chainId(): number | undefined {
    return getAccount(config).chainId;
}

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
 * settles against nothing. wagmi offers the chain to a wallet that has never seen it, from the chain
 * definitions in the config, so there is no second table of RPC urls to keep correct here.
 */
export async function ensureChain(wanted: number): Promise<void> {
    if (getAccount(config).chainId === wanted) return;
    if (!config.chains.some((c) => c.id === wanted)) {
        throw new WalletError(`This payment needs chain ${wanted}. Switch your wallet to it and try again.`);
    }
    await switchChain(config, { chainId: wanted as (typeof config.chains)[number]["id"] });
}

/** The shape a typed-data payload arrives in, from the server or from the payment scheme. */
interface TypedData {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
}

/**
 * The payload as viem wants it.
 *
 * One transformation, and it is the reason this is a named function rather than an inline spread:
 * `EIP712Domain` is dropped from `types`. A raw `eth_signTypedData_v4` call needs the domain's own
 * type declared, so the server sends it; viem derives that type from the domain's fields instead, and
 * a declared one would override what viem derived. The hash is identical either way only while the
 * two agree, and the failure when they do not is a signature the server rejects with nothing to point
 * at. Letting viem derive it means they cannot disagree.
 *
 * Nothing else is touched. Rebuilding the payload here would be a second implementation of the thing
 * the signature is supposed to pin down.
 */
export function signableTypedData(payload: TypedData): TypedData {
    const { EIP712Domain: _declared, ...types } = payload.types;
    return { ...payload, types };
}

/**
 * Signs an EIP-712 payload exactly as it was offered.
 *
 * bigint amounts need no special handling now: an EIP-3009 authorisation carries `value`, `validAfter`
 * and `validBefore` as bigints, and viem encodes a uint256 from one directly rather than through JSON,
 * which is what used to fail with "Do not know how to serialize a BigInt".
 */
export async function signTypedData(address: string, payload: unknown): Promise<string> {
    const td = signableTypedData(payload as TypedData);
    return await wagmiSignTypedData(config, {
        account: address as `0x${string}`,
        domain: td.domain,
        types: td.types,
        primaryType: td.primaryType,
        message: td.message,
    } as never);
}

/**
 * How much USDC the wallet holds, as a decimal string.
 *
 * Six decimals, like every USDC amount in this project, and the division is done on the digits so the
 * value never passes through a float. A failure is a missing number, never an error on screen: a
 * balance is a convenience, and the purchase works without it.
 */
export async function readUsdcBalance(address: string, token: string): Promise<string> {
    const minor = await readContract(config, {
        address: token as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
    });
    const whole = minor / 1_000_000n;
    const frac = (minor % 1_000_000n).toString().padStart(6, "0");
    return `${whole}.${frac}`;
}

/**
 * Turns a wallet rejection into something worth showing a person.
 *
 * wagmi and viem wrap the provider's error, so the EIP-1193 code can be on the error, on its cause, or
 * only in the name. All three are checked, because "User rejected the request" shown as a red failure
 * is the page calling a person's own decision a fault.
 */
export function describeWalletError(e: unknown): string {
    if (e instanceof WalletError) return e.message;
    const err = e as { code?: number; name?: string; shortMessage?: string; cause?: { code?: number; name?: string } };
    const code = err?.code ?? err?.cause?.code;
    const name = err?.name ?? err?.cause?.name;
    if (code === 4001 || name === "UserRejectedRequestError") {
        return "You rejected the request in your wallet. Nothing was sent and nothing was charged.";
    }
    if (code === -32002 || name === "ResourceUnavailableRpcError") {
        return "Your wallet already has a request open. Finish it there, then try again.";
    }
    if (name === "ConnectorAlreadyConnectedError") return "That wallet is already connected.";
    // A session outlives the wallet connection: a reload, a locked extension or a closed app leaves the
    // desk signed in with nothing to sign with, and wagmi's own words for that say nothing useful.
    if (name === "ConnectorNotConnectedError" || (e instanceof Error && /connector not connected/i.test(e.message))) {
        return "Your wallet is not connected. Unlock it or reconnect the owner wallet, then try again. Nothing was signed.";
    }
    if (typeof err?.shortMessage === "string") return err.shortMessage;
    return e instanceof Error ? e.message : String(e);
}
