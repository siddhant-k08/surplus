import { createPublicClient, createWalletClient, http, erc20Abi, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { buildSwap, minOut, type Quote, type SwapOrder } from "@surplus/core";

/**
 * Sending real swaps.
 *
 * One transaction per `SwapOrder`, which is why the plan merges legs that buy the same token: paying gas
 * once per token instead of once per theme. The ledger still records one fill per leg, so a position
 * stays attributable to the themes that funded it.
 *
 * This is the only place in the project that can lose money irreversibly, so it is built to refuse:
 *
 * - it will not construct without `MAINNET_ENABLED` and a spend cap
 * - it checks allowance and balance before sending, rather than discovering them in a revert
 * - it approves exactly what the order needs, never an unlimited allowance
 * - it books a fill only from a confirmed receipt with status success, never from a submitted hash
 * - a spend cap is enforced across the whole run, not per transaction
 */

export interface ExecutorConfig {
    rpcUrl: string;
    privateKey: string;
    usdc: `0x${string}`;
    /** Hard ceiling on what this process may spend onchain, in USDC minor units. */
    spendCapUsdcMinor: bigint;
    mainnetEnabled: boolean;
    slippageBps: number;
}

export interface FilledOrder {
    symbol: string;
    asset: string;
    usdcIn: bigint;
    amountOut: bigint;
    transaction: Hash;
    gasUsed: bigint;
}

export class ExecutorRefused extends Error {}

export class SwapExecutor {
    private spent = 0n;
    private readonly account;
    private readonly publicClient;
    private readonly wallet;

    constructor(private readonly config: ExecutorConfig) {
        if (!config.mainnetEnabled) {
            throw new ExecutorRefused(
                "Real execution needs MAINNET_ENABLED=true. The tokenized stocks only exist on Base mainnet, " +
                "so this moves real money.",
            );
        }
        if (config.spendCapUsdcMinor <= 0n) {
            throw new ExecutorRefused("Real execution needs a positive spend cap.");
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
            throw new ExecutorRefused("Real execution needs a 32 byte hex private key. Use a throwaway wallet.");
        }
        this.account = privateKeyToAccount(config.privateKey as `0x${string}`);
        this.publicClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
        this.wallet = createWalletClient({ account: this.account, chain: base, transport: http(config.rpcUrl) });
    }

    get address(): `0x${string}` {
        return this.account.address;
    }

    /** What this process has spent onchain so far, and what the cap still allows. */
    budget(): { spent: bigint; remaining: bigint } {
        return { spent: this.spent, remaining: this.config.spendCapUsdcMinor - this.spent };
    }

    /** USDC the wallet actually holds. Checked before sending rather than discovered in a revert. */
    async balance(): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.config.usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.account.address],
        });
    }

    private async allowance(router: `0x${string}`): Promise<bigint> {
        return this.publicClient.readContract({
            address: this.config.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [this.account.address, router],
        });
    }

    /**
     * Approves exactly what this order needs, when the existing allowance is short.
     *
     * Never an unlimited approval: an agent holding an infinite allowance to a router is one router bug
     * away from an empty wallet, and the convenience is worth nothing when the amounts are this small.
     */
    private async ensureAllowance(router: `0x${string}`, amount: bigint): Promise<Hash | null> {
        const current = await this.allowance(router);
        if (current >= amount) return null;

        const hash = await this.wallet.writeContract({
            address: this.config.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [router, amount],
            account: this.account,
            chain: base,
        });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`USDC approval failed in ${hash}`);
        return hash;
    }

    /**
     * Executes one order: encode, approve if needed, send, and wait for a successful receipt.
     *
     * Nothing is reported as filled until the receipt says success. A submitted hash is not a fill; a
     * reverted transaction that was treated as one would put a position in the book that does not exist.
     */
    async fill(order: SwapOrder, quote: Quote): Promise<FilledOrder> {
        const { remaining } = this.budget();
        if (order.usdcIn > remaining) {
            throw new ExecutorRefused(
                `order of ${order.usdcIn} would pass the spend cap; ${remaining} of the cap is left`,
            );
        }

        const held = await this.balance();
        if (held < order.usdcIn) {
            throw new ExecutorRefused(`wallet holds ${held} USDC, needs ${order.usdcIn} for ${order.symbol}`);
        }

        const floor = minOut(quote.amountOut, order.maxSlippageBps);
        const built = await buildSwap({
            quote,
            sender: this.account.address,
            recipient: this.account.address,
            slippageBps: order.maxSlippageBps,
            minOut: floor,
        });

        await this.ensureAllowance(built.router, built.amountIn);

        const hash = await this.wallet.sendTransaction({
            to: built.router,
            data: built.data,
            account: this.account,
            chain: base,
        });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
            throw new Error(`swap for ${order.symbol} reverted in ${hash}; nothing was filled`);
        }

        // counted only once the chain has confirmed it, so a failed send cannot eat the cap
        this.spent += order.usdcIn;

        return {
            symbol: order.symbol,
            asset: order.asset,
            usdcIn: order.usdcIn,
            amountOut: built.amountOut,
            transaction: hash,
            gasUsed: receipt.gasUsed,
        };
    }
}

/**
 * Builds an executor, or explains why there will not be one.
 *
 * Returning the reason rather than throwing lets the server start and say plainly that fills are
 * simulated, which is the normal state until mainnet is deliberately turned on.
 */
export function openExecutor(
    config: Partial<ExecutorConfig> & { mainnetEnabled: boolean },
): { executor: SwapExecutor } | { executor: null; why: string } {
    try {
        if (config.rpcUrl === undefined || config.rpcUrl === "") {
            return { executor: null, why: "no BASE_RPC_URL is set" };
        }
        if (config.privateKey === undefined || config.privateKey === "") {
            return { executor: null, why: "no execution key is set" };
        }
        return {
            executor: new SwapExecutor({
                rpcUrl: config.rpcUrl,
                privateKey: config.privateKey,
                usdc: config.usdc ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                spendCapUsdcMinor: config.spendCapUsdcMinor ?? 0n,
                mainnetEnabled: config.mainnetEnabled,
                slippageBps: config.slippageBps ?? 100,
            }),
        };
    } catch (e) {
        return { executor: null, why: e instanceof Error ? e.message : String(e) };
    }
}
