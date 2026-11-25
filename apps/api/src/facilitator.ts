import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import type { ApiConfig } from "./config";
import { BASE_MAINNET, BASE_SEPOLIA } from "./config";

/**
 * Who settles the payments: someone else's server, or this process.
 *
 * The free facilitator at x402.org serves Base Sepolia and advertises no other EVM network, so with it
 * the agent can only ever earn testnet USDC. The tokenized stocks exist only on Base mainnet. That split
 * is the whole reason the money loop cannot close with real money: revenue arrives on a chain the
 * investing half cannot spend on, and `syncRevenue` refuses to mirror across networks precisely so a
 * mainnet book can never spend money it claims to have earned on testnet.
 *
 * Running the facilitator here closes the split without a paid provider. `x402ResourceServer` takes a
 * client of `verify`, `settle` and `getSupported`, which is exactly what `x402Facilitator` is, so the
 * local one drops into the same seam with no network hop. It also removes two failure modes that have
 * already cost a sale: the facilitator timing out, and a region that cannot reach it.
 *
 * What it costs is a wallet. The facilitator submits the buyer's signed EIP-3009 authorization and pays
 * the gas itself, which is why a buyer needs USDC but no ETH. Self-hosting moves that gas bill here, so
 * the settlement wallet needs ETH on whichever chain is being served.
 *
 * **The settlement key is not the trading key.** They are different jobs with different blast radii: the
 * settlement key signs gas-paying transactions for other people's payments and its address is published
 * in `getSupported`, while the trading key spends the agent's own USDC. Sharing one would let a bug in
 * either reach the other's money, so a shared key is refused rather than warned about.
 */

export type FacilitatorClient = HTTPFacilitatorClient | x402Facilitator;

export interface FacilitatorChoice {
    client: FacilitatorClient;
    /** `hosted` or `local`, named in the banner and in `GET /health`: never a guess which one settles. */
    kind: "hosted" | "local";
    /** How it reads to a person, with the address that pays the gas when it is this process. */
    detail: string;
    /** The address that settles, when this process is the one settling. */
    address?: string;
    /**
     * Asks the RPC which chain it is actually on, and refuses the mismatch.
     *
     * Worth a round trip at startup because the alternative is finding out during a settlement, with a
     * buyer's signed authorization already in hand and nothing useful to tell them. The two RPCs in this
     * system point at different chains for as long as the agent sells on Sepolia and trades on mainnet,
     * so pointing one at the other's chain is an ordinary mistake rather than an exotic one.
     */
    verifyChain?: () => Promise<void>;
}

const CHAINS: Record<string, Chain> = {
    [BASE_MAINNET]: base,
    [BASE_SEPOLIA]: baseSepolia,
};

export interface LocalFacilitatorEnv {
    rpcUrl: string;
    privateKey: string;
    /** The trading key, refused if it is the same one. */
    executionKey: string;
    /**
     * How long to wait for a settlement receipt.
     *
     * Kept under the host's request deadline on purpose. The scheme reports `settlement_pending` with
     * the broadcast hash rather than being killed mid-wait, which leaves something to reconcile against
     * instead of a payment that happened with nothing written down.
     */
    confirmationTimeoutMs: number;
}

/** The local facilitator, or the reason it cannot be built. */
export function openLocalFacilitator(
    network: string,
    env: LocalFacilitatorEnv,
): { client: x402Facilitator; address: string; verifyChain: () => Promise<void> } | { client: null; why: string } {
    const chain = CHAINS[network];
    if (chain === undefined) return { client: null, why: `no viem chain is known for ${network}` };
    if (env.rpcUrl === "") {
        return { client: null, why: `no RPC url is set for ${network}` };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.privateKey)) {
        return { client: null, why: "FACILITATOR_PRIVATE_KEY must be a 0x-prefixed 32 byte hex key" };
    }
    if (env.executionKey !== "" && env.executionKey.toLowerCase() === env.privateKey.toLowerCase()) {
        return {
            client: null,
            why: "FACILITATOR_PRIVATE_KEY must not be the same key as EXECUTION_PRIVATE_KEY: " +
                "the settlement wallet pays other people's gas and publishes its address, the trading " +
                "wallet spends the agent's own USDC",
        };
    }

    const account = privateKeyToAccount(env.privateKey as `0x${string}`);
    const transport = http(env.rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const wallet = createWalletClient({ account, chain, transport });

    // One object with both halves, which is the shape the signer helper expects: reads and signature
    // checks from the public client, writes and receipts from the wallet.
    // Typed from the helper's own parameter, so the shape stays correct if the package changes it.
    // Each call still needs a cast: viem's overloads are far more precise than the structural shape
    // x402 asks for, and widening them here would be claiming a type guarantee that is not being made.
    const client: Parameters<typeof toFacilitatorEvmSigner>[0] = {
        address: account.address,
        readContract: (args) => publicClient.readContract(args as never),
        verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
        writeContract: (args) => wallet.writeContract(args as never),
        sendTransaction: (args) => wallet.sendTransaction(args as never),
        waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args as never),
        getCode: (args) => publicClient.getCode(args),
    };
    const signer = toFacilitatorEvmSigner(client, { confirmationTimeoutMs: env.confirmationTimeoutMs });

    const facilitator = new x402Facilitator();
    registerExactEvmScheme(facilitator, { signer, networks: network as never });

    /*
     * Settle on one network only: the one this wallet has an RPC for.
     *
     * `registerExactEvmScheme` also registers the v1 scheme across every EVM network the package knows,
     * so `getSupported` advertises polygon, celo, monad and twenty others that this process cannot reach.
     * The resource server names a single network in its own 402 challenge, so an honest buyer never sees
     * the rest, but the facilitator takes whatever payload it is handed, and this wallet is the one
     * paying the gas for it. Refusing anything but the configured network keeps that surface the size it
     * looks.
     */
    const onlyThisNetwork = async (ctx: { requirements: { network?: string } }) => {
        const asked = ctx.requirements.network;
        if (asked === network) return;
        return {
            abort: true as const,
            reason: "unsupported_network",
            message: `this facilitator settles ${network} only, not ${String(asked)}`,
        };
    };
    facilitator.onBeforeVerify(onlyThisNetwork as never);
    facilitator.onBeforeSettle(onlyThisNetwork as never);

    const verifyChain = async (): Promise<void> => {
        const actual = await publicClient.getChainId();
        if (actual === chain.id) return;
        throw new Error(
            `the facilitator RPC is on chain ${actual} but this server settles ${network} ` +
            `(chain ${chain.id}). Point FACILITATOR_RPC_URL at ${chain.name}.`,
        );
    };

    return { client: facilitator, address: account.address, verifyChain };
}

/**
 * Whichever facilitator this deployment is configured for.
 *
 * Hosted is the default and stays the default: it is what every sale so far has settled through, and
 * switching the thing that moves a buyer's money is not something to do by omission. `local` is opt-in
 * through `X402_FACILITATOR=local`, and a local facilitator that cannot be built is an error rather than
 * a silent fall back to the hosted one: a deployment that asked to settle its own payments and quietly
 * handed them to someone else's server is the kind of surprise this project does not allow.
 */
/** The RPC variable that names the chain being served. */
function rpcVarFor(network: string, env: NodeJS.ProcessEnv): string | undefined {
    return network === BASE_SEPOLIA ? env.BASE_SEPOLIA_RPC_URL : env.BASE_RPC_URL;
}

export function openFacilitator(config: ApiConfig, env: NodeJS.ProcessEnv = process.env): FacilitatorChoice {
    const hosted = (): FacilitatorChoice => ({
        client: new HTTPFacilitatorClient({
            url: config.facilitatorUrl,
            timeoutMs: config.facilitatorTimeoutMs,
        }),
        kind: "hosted",
        detail: config.facilitatorUrl,
    });

    if ((env.X402_FACILITATOR ?? "hosted").trim() !== "local") return hosted();

    const local = openLocalFacilitator(config.network, {
        /*
         * The RPC for the chain being served, named after that chain.
         *
         * Not `BASE_RPC_URL` unconditionally: that one belongs to the executor, which swaps tokenized
         * stocks and so is always on Base mainnet, while the facilitator has to be on whatever
         * `X402_NETWORK` says. Those are different chains for as long as the agent sells on Sepolia and
         * trades on mainnet, and one variable pointed at either leaves the other half silently wrong
         * until money is in flight. Keying the lookup on the network removes the choice: on mainnet the
         * two are the same endpoint and the same variable, which is the end state.
         *
         * `FACILITATOR_RPC_URL` overrides both, for a deployment that wants its settlement traffic on a
         * separate endpoint from its trading traffic.
         */
        rpcUrl: (env.FACILITATOR_RPC_URL ?? rpcVarFor(config.network, env) ?? "").trim(),
        privateKey: (env.FACILITATOR_PRIVATE_KEY ?? "").trim(),
        executionKey: (env.EXECUTION_PRIVATE_KEY ?? "").trim(),
        // Under the host's ceiling, so a slow confirmation is reported rather than cut off.
        confirmationTimeoutMs: config.facilitatorTimeoutMs,
    });
    if (local.client === null) {
        throw new Error(
            `X402_FACILITATOR=local was set but this process cannot settle payments: ${local.why}. ` +
            "Unset it to use the hosted facilitator.",
        );
    }
    return {
        client: local.client,
        kind: "local",
        detail: `in process, settled by ${local.address} on ${config.network}`,
        address: local.address,
        verifyChain: local.verifyChain,
    };
}
