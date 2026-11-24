import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
    buildSwap, comparePositions, minOut,
    type PositionReconciliation, type Quote, type SwapOrder,
} from "@surplus/core";
import { MemoryJournal, type ExecutionJournal, type ExecutionRecord } from "./journal";
import { log, errorFields } from "./log";

/** Six decimals, for a message a person reads. Money is compared as integers everywhere else. */
const formatUsdcMinor = (v: bigint): string => {
    const neg = v < 0n;
    const abs = neg ? -v : v;
    return `${neg ? "-" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
};

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
    /** Native balance, for gas. A wallet with USDC and no ETH cannot send anything. */
    nativeBalance(): Promise<bigint>;
    /** Units of any token the wallet holds. The chain's own answer, for reconciliation. */
    tokenBalance(token: `0x${string}`): Promise<bigint>;
    /** A sale sends the token, not USDC, so the router needs an allowance on the token itself. */
    tokenAllowance(token: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
    approveToken(token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<Hash>;
    /** Which chain is actually on the other end of the RPC. */
    chainId(): Promise<number>;
}

/** One thing checked before a real swap, and what was found. */
export interface PreflightCheck {
    name: string;
    ok: boolean;
    detail: string;
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
            nativeBalance: async () => publicClient.getBalance({ address: account.address }),
            tokenBalance: async (token) => publicClient.readContract({
                address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
            }) as Promise<bigint>,
            tokenAllowance: async (token, spender) => publicClient.readContract({
                address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, spender],
            }) as Promise<bigint>,
            approveToken: async (token, spender, amount) => wallet.writeContract({
                address: token, abi: erc20Abi, functionName: "approve",
                args: [spender, amount], account, chain: base,
            }),
            chainId: async () => publicClient.getChainId(),
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
     * The same thing for the token being sold.
     *
     * A sale sends the stock token to the router and gets USDC back, so the allowance that matters is on
     * the token, not on USDC. Exactly what the order needs, never unlimited, for the same reason the
     * USDC approval is exact.
     */
    private async ensureTokenAllowance(
        token: `0x${string}`,
        router: `0x${string}`,
        amount: bigint,
        symbol: string,
    ): Promise<Hash | null> {
        const current = await this.chain.tokenAllowance(token, router);
        if (current >= amount) return null;

        const hash = await this.chain.approveToken(token, router, amount);
        const receipt = await this.chain.waitFor(hash);
        if (receipt.status !== "success") throw new Error(`${symbol} approval failed in ${hash}`);
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

        const selling = order.side === "sell";
        const unitsIn = order.unitsIn ?? 0n;

        if (selling) {
            // A sale does not spend from the cap, it returns USDC, so the cap is not consulted. What it
            // can run out of is the token itself.
            if (unitsIn <= 0n) throw new ExecutorRefused(`sale of ${order.symbol} has no units to send`);
            const units = await this.chain.tokenBalance(order.asset as `0x${string}`);
            if (units < unitsIn) {
                throw new ExecutorRefused(
                    `wallet holds ${units} units of ${order.symbol}, needs ${unitsIn} to sell`,
                );
            }
        } else {
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
        }

        // Claimed before anything is built, so two callers racing on the same order cannot both proceed.
        const reserved = await this.journal.reserve({
            key, symbol: order.symbol, asset: order.asset, usdcInMinor: order.usdcIn,
            ...(selling && { side: "sell" as const, unitsInMinor: unitsIn }),
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

            if (selling) {
                await this.ensureTokenAllowance(
                    order.asset as `0x${string}`, built.router, built.amountIn, order.symbol,
                );
            } else {
                await this.ensureAllowance(built.router, built.amountIn);
            }

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
     * What the books say the wallet holds, against what it actually holds.
     *
     * The internal reconciliation proves the books agree with themselves, which is not the same as
     * being true. This is the check that can catch a lie, and it is only meaningful once real swaps
     * have happened: it compares the units the journal recorded receiving against the chain's own
     * answer, with no price or quote involved anywhere.
     */
    async positions(): Promise<PositionReconciliation> {
        const byAsset = new Map<string, { symbol: string; units: bigint }>();
        for (const record of await this.journal.filled()) {
            const key = record.asset.toLowerCase();
            const seen = byAsset.get(key);
            // A buy received units; a sale sent them. `amountOutMinor` on a sale is USDC, not tokens, so
            // adding it would both inflate the position and lose the disposal, and the books would then
            // report themselves short of tokens they had correctly sold.
            const units = record.side === "sell" ? -(record.unitsInMinor ?? 0n) : (record.amountOutMinor ?? 0n);
            if (seen === undefined) byAsset.set(key, { symbol: record.symbol, units });
            else seen.units += units;
        }

        const held = new Map<string, bigint>();
        for (const asset of byAsset.keys()) {
            held.set(asset, await this.chain.tokenBalance(asset as `0x${string}`));
        }

        return comparePositions(
            [...byAsset].map(([asset, v]) => ({ asset, symbol: v.symbol, units: v.units })),
            held,
        );
    }

    /**
     * Everything `fill` would do, stopping before the broadcast.
     *
     * The point of this is that it is not a separate implementation: it builds the same calldata through
     * the same code and asks the chain the same question, so what it reports is what would happen, not
     * an argument that it ought to work. Nothing is signed and nothing is sent.
     */
    async preflight(order: SwapOrder, quote: Quote): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
        const checks: PreflightCheck[] = [];
        const add = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });

        try {
            const id = await this.chain.chainId();
            const right = id === base.id;
            add("network", right, right ? `Base mainnet (${id})` : `chain ${id}, expected ${base.id}`);
            // nothing below means anything against the wrong chain: not the balances, not the calldata
            if (!right) return { ok: false, checks };
        } catch (e) {
            add("network", false, `the RPC did not answer: ${e instanceof Error ? e.message : String(e)}`);
            return { ok: false, checks };
        }

        const { spent, remaining } = await this.budget();
        add(
            "spend cap",
            order.usdcIn <= remaining,
            `${formatUsdcMinor(remaining)} USDC of the cap left, this order needs ${formatUsdcMinor(order.usdcIn)} ` +
            `(${formatUsdcMinor(spent)} already committed)`,
        );

        const held = await this.balance();
        add("USDC", held >= order.usdcIn, `wallet holds ${formatUsdcMinor(held)} USDC`);

        const gas = await this.chain.nativeBalance();
        add("gas", gas > 0n, gas > 0n ? `${gas} wei of ETH for gas` : "no ETH for gas, so nothing can be sent");

        let built;
        try {
            built = await this.build({
                quote,
                sender: this.account.address,
                recipient: this.account.address,
                slippageBps: order.maxSlippageBps,
                minOut: minOut(quote.amountOut, order.maxSlippageBps),
            });
            add(
                "calldata",
                true,
                `router ${built.router}, spends ${formatUsdcMinor(built.amountIn)} USDC, ` +
                `expects ${built.amountOut} units, reverts below ${built.minOut}`,
            );
        } catch (e) {
            add("calldata", false, e instanceof Error ? e.message : String(e));
            return { ok: false, checks };
        }

        const allowance = await this.allowance(built.router);
        add(
            "allowance",
            true,
            allowance >= built.amountIn
                ? `${formatUsdcMinor(allowance)} USDC already approved to the router`
                : `${formatUsdcMinor(allowance)} USDC approved; a real run would approve exactly ` +
                  `${formatUsdcMinor(built.amountIn)} first`,
        );

        if (allowance >= built.amountIn) {
            try {
                await this.chain.simulate({ to: built.router, data: built.data });
                add("simulation", true, "the swap would succeed against the chain as it stands");
            } catch (e) {
                add("simulation", false, `the swap would revert: ${e instanceof Error ? e.message : String(e)}`);
            }
        } else {
            // simulating a transfer the router is not yet allowed to make would fail for the wrong reason
            add("simulation", true, "not simulated: the router needs its approval first, which a real run does");
        }

        return { ok: checks.every((c) => c.ok), checks };
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
                    log.error("execution_unresolved", `execution ${record.key} is still unresolved`, {
                        key: record.key,
                        symbol: record.symbol,
                        transaction: record.txHash,
                        ...errorFields(e),
                    });
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
