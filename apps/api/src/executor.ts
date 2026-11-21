import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { buildSwap, minOut, type Quote, type SwapOrder } from "@surplus/core";
import { MemoryJournal, type ExecutionJournal, type ExecutionRecord } from "./journal";

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
 * - it simulates the swap first, so a revert costs nothing and is read before it is paid for
 * - it approves exactly what the order needs, never an unlimited allowance
 * - it books a fill only from a confirmed receipt with status success, never from a submitted hash
 * - the spend cap is counted in storage, so it is one cap however many instances are running
 *
 * The ordering around the send is the part that matters most. The transaction is signed first, which
 * fixes its hash without putting it on the chain, and the hash is written to the journal before it is
 * broadcast. A process that dies anywhere after that can ask the chain what became of a transaction it
 * knows it signed. Sending first and recording after would leave a gap in which money moves and nothing
 * remembers, and no care inside the function closes that gap.
 */

/**
 * The chain, as narrowly as this needs it.
 *
 * An interface rather than viem's clients directly, so the ordering above can be tested without a
 * network: the failure this is built around is a crash between two calls, which is not something a
 * real node helps you reproduce.
 */
export interface ChainAccess {
    readUsdc(fn: "balanceOf" | "allowance", args: readonly `0x${string}`[]): Promise<bigint>;
    approve(spender: `0x${string}`, amount: bigint): Promise<Hash>;
    /** Throws when the call would revert. Costs nothing. */
    simulate(tx: { to: `0x${string}`; data: `0x${string}` }): Promise<void>;
    /** Signs without broadcasting, so the hash is known before the chain is. */
    sign(tx: { to: `0x${string}`; data: `0x${string}` }): Promise<{ hash: Hash; raw: `0x${string}` }>;
    broadcast(raw: `0x${string}`): Promise<Hash>;
    waitFor(hash: Hash): Promise<{ status: "success" | "reverted"; gasUsed: bigint }>;
    /** The receipt if the chain has one, or null if it has never seen the transaction. */
    receiptFor(hash: Hash): Promise<{ status: "success" | "reverted"; gasUsed: bigint } | null>;
}

export interface ExecutorConfig {
    rpcUrl: string;
    privateKey: string;
    usdc: `0x${string}`;
    /** Hard ceiling on what this process may spend onchain, in USDC minor units. */
    spendCapUsdcMinor: bigint;
    mainnetEnabled: boolean;
    slippageBps: number;
    /** Where intents are written before they are sent. In memory by default, which is not enough on a
     * host that can replace the process; the deployment passes a shared one. */
    journal?: ExecutionJournal;
    /** Injectable so the ordering can be tested without a chain. */
    chain?: ChainAccess;
    /**
     * How calldata is produced. The real one asks the aggregator.
     *
     * Injectable for the same reason as the chain: these tests are about what happens around the send,
     * and they should not depend on a third party's endpoint being up and agreeing with a fixture.
     */
    build?: typeof buildSwap;
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
    private readonly account;
    private readonly publicClient;
    private readonly wallet;
    private readonly journal: ExecutionJournal;
    private readonly chain: ChainAccess;
    private readonly build: typeof buildSwap;

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
        this.journal = config.journal ?? new MemoryJournal();
        this.chain = config.chain ?? this.viemChain();
        this.build = config.build ?? buildSwap;
    }

    /** The real chain, through viem. */
    private viemChain(): ChainAccess {
        const account = this.account;
        const publicClient = this.publicClient;
        const wallet = this.wallet;
        const usdc = this.config.usdc;
        return {
            readUsdc: async (fn, args) => publicClient.readContract({
                address: usdc,
                abi: erc20Abi,
                functionName: fn,
                args: args as never,
            }) as Promise<bigint>,
            approve: async (spender, amount) => wallet.writeContract({
                address: usdc, abi: erc20Abi, functionName: "approve",
                args: [spender, amount], account, chain: base,
            }),
            simulate: async (tx) => {
                // eth_call against the current state: a revert here is free and is read before paying
                await publicClient.call({ account, to: tx.to, data: tx.data });
            },
            sign: async (tx) => {
                const request = await wallet.prepareTransactionRequest({
                    to: tx.to, data: tx.data, account, chain: base,
                });
                const raw = await wallet.signTransaction(request as never);
                return { hash: keccak256(raw), raw };
            },
            broadcast: async (raw) => publicClient.sendRawTransaction({ serializedTransaction: raw }),
            waitFor: async (hash) => {
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                return { status: receipt.status, gasUsed: receipt.gasUsed };
            },
            receiptFor: async (hash) => {
                try {
                    const receipt = await publicClient.getTransactionReceipt({ hash });
                    return { status: receipt.status, gasUsed: receipt.gasUsed };
                } catch {
                    return null; // the chain has never seen it
                }
            },
        };
    }

    get address(): `0x${string}` {
        return this.account.address;
    }

    /**
     * What has been committed onchain and what the cap still allows.
     *
     * Read from the journal rather than a field, so every instance sees the same number. Anything not
     * known to have failed counts: a transaction whose outcome is unknown may well have spent the money.
     */
    async budget(): Promise<{ spent: bigint; remaining: bigint }> {
        const spent = await this.journal.committedUsdcMinor();
        return { spent, remaining: this.config.spendCapUsdcMinor - spent };
    }

    /** USDC the wallet actually holds. Checked before sending rather than discovered in a revert. */
    async balance(): Promise<bigint> {
        return this.chain.readUsdc("balanceOf", [this.account.address]);
    }

    private async allowance(router: `0x${string}`): Promise<bigint> {
        return this.chain.readUsdc("allowance", [this.account.address, router]);
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

        const hash = await this.chain.approve(router, amount);
        const receipt = await this.chain.waitFor(hash);
        if (receipt.status !== "success") throw new Error(`USDC approval failed in ${hash}`);
        return hash;
    }

    /**
     * Executes one order: encode, approve if needed, send, and wait for a successful receipt.
     *
     * Nothing is reported as filled until the receipt says success. A submitted hash is not a fill; a
     * reverted transaction that was treated as one would put a position in the book that does not exist.
     */
    async fill(order: SwapOrder, quote: Quote, key: string): Promise<FilledOrder> {
        const claimed = await this.journal.find(key);
        if (claimed !== null) {
            // This order has been here before. Whatever happened to it, the answer is in the journal or
            // on the chain, and the one thing that must not happen is a second swap for the same order.
            return this.resume(claimed);
        }

        const { remaining } = await this.budget();
        if (order.usdcIn > remaining) {
            throw new ExecutorRefused(
                `order of ${order.usdcIn} would pass the spend cap; ${remaining} of the cap is left`,
            );
        }

        const held = await this.balance();
        if (held < order.usdcIn) {
            throw new ExecutorRefused(`wallet holds ${held} USDC, needs ${order.usdcIn} for ${order.symbol}`);
        }

        // Claimed before anything is built, so two callers racing on the same order cannot both proceed.
        const reserved = await this.journal.reserve({
            key, symbol: order.symbol, asset: order.asset, usdcInMinor: order.usdcIn,
        });
        if (reserved.status !== "pending") return this.resume(reserved);

        try {
            const floor = minOut(quote.amountOut, order.maxSlippageBps);
            const built = await this.build({
                quote,
                sender: this.account.address,
                recipient: this.account.address,
                slippageBps: order.maxSlippageBps,
                minOut: floor,
            });

            await this.ensureAllowance(built.router, built.amountIn);

            // Free, and read before anything is paid for. A swap that would revert is a swap not sent.
            await this.chain.simulate({ to: built.router, data: built.data });

            // Signed, recorded, then broadcast. In that order, so a crash can never leave a transaction
            // on the chain that nothing here knows the hash of.
            const signed = await this.chain.sign({ to: built.router, data: built.data });
            await this.journal.recordSigned(key, signed.hash, signed.raw);
            await this.chain.broadcast(signed.raw);

            const receipt = await this.chain.waitFor(signed.hash);
            if (receipt.status !== "success") {
                await this.journal.settle(key, { status: "failed", detail: `reverted in ${signed.hash}` });
                throw new Error(`swap for ${order.symbol} reverted in ${signed.hash}; nothing was filled`);
            }
            await this.journal.settle(key, {
                status: "filled", amountOutMinor: built.amountOut, gasUsed: receipt.gasUsed,
            });

            return {
                symbol: order.symbol,
                asset: order.asset,
                usdcIn: order.usdcIn,
                amountOut: built.amountOut,
                transaction: signed.hash,
                gasUsed: receipt.gasUsed,
            };
        } catch (e) {
            // Only a claim that never became a signature is released. Once a transaction is signed its
            // hash is on record and its outcome belongs to the chain, not to this function.
            const current = await this.journal.find(key);
            if (current?.status === "pending") await this.journal.release(key);
            throw e;
        }
    }

    /**
     * Picks up an order that has been attempted before.
     *
     * The journal says what was decided; the chain says what became of it. A transaction that was signed
     * but never reached the chain is rebroadcast rather than rebuilt, because rebuilding it would be a
     * different transaction and could spend the money twice.
     */
    private async resume(record: ExecutionRecord): Promise<FilledOrder> {
        if (record.status === "filled") {
            if (record.txHash === undefined || record.amountOutMinor === undefined) {
                throw new Error(`execution ${record.key} is recorded as filled but is missing its result`);
            }
            return {
                symbol: record.symbol,
                asset: record.asset,
                usdcIn: record.usdcInMinor,
                amountOut: record.amountOutMinor,
                transaction: record.txHash as Hash,
                gasUsed: record.gasUsed ?? 0n,
            };
        }
        if (record.status === "failed") {
            throw new ExecutorRefused(
                `execution ${record.key} already failed (${record.detail ?? "no detail"}); ` +
                "propose again rather than retrying the same order",
            );
        }
        if (record.status === "pending") {
            throw new ExecutorRefused(
                `execution ${record.key} is already under way in this or another instance`,
            );
        }

        // sent: the hash is known, so the chain is the authority
        const hash = record.txHash as Hash | undefined;
        if (hash === undefined) throw new Error(`execution ${record.key} is marked sent with no hash`);

        let receipt = await this.chain.receiptFor(hash);
        if (receipt === null && record.rawTx !== undefined) {
            // signed, recorded, and the broadcast never landed. The same bytes, so the same transaction.
            await this.chain.broadcast(record.rawTx as `0x${string}`);
            receipt = await this.chain.waitFor(hash);
        } else if (receipt === null) {
            receipt = await this.chain.waitFor(hash);
        }

        if (receipt.status !== "success") {
            await this.journal.settle(record.key, { status: "failed", detail: `reverted in ${hash}` });
            throw new Error(`swap for ${record.symbol} reverted in ${hash}; nothing was filled`);
        }
        await this.journal.settle(record.key, { status: "filled", gasUsed: receipt.gasUsed });
        return {
            symbol: record.symbol,
            asset: record.asset,
            usdcIn: record.usdcInMinor,
            amountOut: record.amountOutMinor ?? 0n,
            transaction: hash,
            gasUsed: receipt.gasUsed,
        };
    }

    /**
     * Resolves every transaction whose outcome is unknown, against the chain.
     *
     * Called at start-up. Until this has run, the agent's books may be missing a swap that really
     * happened, and the spend cap counts those as spent, which is the safe direction.
     */
    async recover(): Promise<{ key: string; outcome: "filled" | "failed" | "unknown" }[]> {
        const out: { key: string; outcome: "filled" | "failed" | "unknown" }[] = [];
        for (const record of await this.journal.unresolved()) {
            try {
                await this.resume(record);
                out.push({ key: record.key, outcome: "filled" });
            } catch (e) {
                const current = await this.journal.find(record.key);
                out.push({
                    key: record.key,
                    outcome: current?.status === "failed" ? "failed" : "unknown",
                });
                if (current?.status !== "failed") {
                    console.error(`execution ${record.key} is still unresolved:`, e);
                }
            }
        }
        return out;
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
                ...(config.journal !== undefined && { journal: config.journal }),
                ...(config.chain !== undefined && { chain: config.chain }),
                ...(config.build !== undefined && { build: config.build }),
            }),
        };
    } catch (e) {
        return { executor: null, why: e instanceof Error ? e.message : String(e) };
    }
}
