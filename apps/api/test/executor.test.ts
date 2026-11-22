import { describe, it, expect } from "vitest";
import { parseUsdc as u } from "@surplus/core";
import { SwapExecutor, ExecutorRefused, openExecutor, type ChainAccess } from "../src/executor";
import { MemoryJournal } from "../src/journal";

const KEY = "0x" + "77".repeat(32);
const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const config = (over: Partial<Parameters<typeof openExecutor>[0]> = {}) => ({
    rpcUrl: RPC,
    privateKey: KEY,
    usdc: USDC,
    spendCapUsdcMinor: u("20.00"),
    mainnetEnabled: true,
    slippageBps: 100,
    ...over,
});

describe("the executor refuses before it can lose money", () => {
    it("will not exist without mainnet explicitly enabled", () => {
        expect(() => new SwapExecutor(config({ mainnetEnabled: false }) as never))
            .toThrow(/MAINNET_ENABLED/);
    });

    it("will not exist without a spend cap", () => {
        expect(() => new SwapExecutor(config({ spendCapUsdcMinor: 0n }) as never))
            .toThrow(/positive spend cap/);
        expect(() => new SwapExecutor(config({ spendCapUsdcMinor: -1n }) as never))
            .toThrow(/positive spend cap/);
    });

    it("will not exist without a usable key", () => {
        expect(() => new SwapExecutor(config({ privateKey: "nope" }) as never))
            .toThrow(/32 byte hex private key/);
    });

    it("starts with its whole cap unspent", async () => {
        const ex = new SwapExecutor(config() as never);
        expect(await ex.budget()).toEqual({ spent: 0n, remaining: u("20.00") });
        expect(ex.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
});

describe("openExecutor explains itself rather than throwing", () => {
    it("declines quietly when mainnet is off, so the server can still start", () => {
        const r = openExecutor(config({ mainnetEnabled: false }));
        expect(r.executor).toBe(null);
        if (r.executor === null) expect(r.why).toMatch(/MAINNET_ENABLED/);
    });

    it("declines when there is no rpc or no key", () => {
        expect(openExecutor(config({ rpcUrl: "" })).executor).toBe(null);
        expect(openExecutor(config({ privateKey: "" })).executor).toBe(null);
    });

    it("opens when everything it needs is present and authorized", () => {
        const r = openExecutor(config());
        expect(r.executor).not.toBe(null);
    });

    it("declines when the cap is missing, rather than defaulting to one", () => {
        // a default cap would be a number nobody chose standing between the agent and real money
        const { spendCapUsdcMinor: _drop, ...rest } = config();
        const r = openExecutor(rest);
        expect(r.executor).toBe(null);
        if (r.executor === null) expect(r.why).toMatch(/spend cap/);
    });
});

describe("sending a swap without losing track of it", () => {
    const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;
    const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const RAW = ("0x" + "cd".repeat(60)) as `0x${string}`;

    const order = {
        symbol: "NVDAc",
        asset: "0x" + "11".repeat(20),
        usdcIn: u("1.00"),
        maxSlippageBps: 100,
    } as unknown as Parameters<SwapExecutor["fill"]>[0];

    const quote = {
        amountOut: 1_000_000n,
        router: ROUTER,
        data: ("0x" + "ee".repeat(20)) as `0x${string}`,
        amountIn: u("1.00"),
    } as unknown as Parameters<SwapExecutor["fill"]>[1];

    /** A chain that records what it was asked to do, and can be told to fail at a chosen step. */
    function fakeChain(over: Partial<ChainAccess> & { failAt?: "simulate" | "broadcast" } = {}) {
        const calls: string[] = [];
        const base: ChainAccess = {
            readUsdc: async (fn) => {
                calls.push(`read:${fn}`);
                return fn === "balanceOf" ? u("100.00") : u("1000.00");
            },
            approve: async () => { calls.push("approve"); return HASH; },
            simulate: async () => {
                calls.push("simulate");
                if (over.failAt === "simulate") throw new Error("execution reverted: INSUFFICIENT_OUTPUT_AMOUNT");
            },
            sign: async () => { calls.push("sign"); return { hash: HASH, raw: RAW }; },
            broadcast: async () => {
                calls.push("broadcast");
                if (over.failAt === "broadcast") throw new Error("connection lost");
                return HASH;
            },
            waitFor: async () => { calls.push("waitFor"); return { status: "success" as const, gasUsed: 21_000n }; },
            receiptFor: async () => { calls.push("receiptFor"); return null; },
            nativeBalance: async () => 10_000_000_000_000n,
            chainId: async () => 8453,
        };
        return { chain: { ...base, ...over }, calls };
    }

    /** Calldata, without asking the aggregator: these tests are about what happens around the send. */
    const build = async () => ({
        router: ROUTER as `0x${string}`,
        data: ("0x" + "ee".repeat(20)) as `0x${string}`,
        amountIn: u("1.00"),
        amountOut: 1_000_000n,
        minOut: 990_000n,
        gas: null,
    });

    const executorWith = (chain: ChainAccess, journal: MemoryJournal) =>
        new SwapExecutor(config({ chain, journal, build }) as never);

    it("simulates, signs, records and only then broadcasts", async () => {
        // the ordering is the whole point: a hash that reaches the chain before it reaches the journal
        // is money moving with nothing remembering
        const journal = new MemoryJournal();
        const { chain, calls } = fakeChain();
        const filled = await executorWith(chain, journal).fill(order, quote, "p1:0");

        expect(calls.filter((c) => c === "sign" || c === "broadcast" || c === "simulate"))
            .toEqual(["simulate", "sign", "broadcast"]);
        expect(filled.transaction).toBe(HASH);
        const record = await journal.find("p1:0");
        expect(record?.status).toBe("filled");
        expect(record?.txHash).toBe(HASH);
    });

    it("records the signed transaction before the broadcast, so a lost broadcast is recoverable", async () => {
        const journal = new MemoryJournal();
        const failing = fakeChain({ failAt: "broadcast" });
        await expect(executorWith(failing.chain, journal).fill(order, quote, "p1:0")).rejects.toThrow(/connection lost/);

        // the intent survived with its hash, and the claim was not released: the transaction is signed
        const stranded = await journal.find("p1:0");
        expect(stranded?.status).toBe("sent");
        expect(stranded?.txHash).toBe(HASH);
        expect(stranded?.rawTx).toBe(RAW);

        // a later attempt rebroadcasts the same bytes rather than signing a second transaction
        const recovering = fakeChain({ receiptFor: async () => null });
        const again = await executorWith(recovering.chain, journal).fill(order, quote, "p1:0");
        expect(recovering.calls).not.toContain("sign");
        expect(recovering.calls).toContain("broadcast");
        expect(again.transaction).toBe(HASH);
        expect((await journal.find("p1:0"))?.status).toBe("filled");
    });

    it("asks the chain rather than resending when the transaction is already there", async () => {
        const journal = new MemoryJournal();
        await journal.reserve({ key: "p1:0", symbol: "NVDAc", asset: order.asset, usdcInMinor: u("1.00") });
        await journal.recordSigned("p1:0", HASH, RAW);

        const { chain, calls } = fakeChain({
            receiptFor: async () => ({ status: "success", gasUsed: 42_000n }),
        });
        const filled = await executorWith(chain, journal).fill(order, quote, "p1:0");
        expect(calls).not.toContain("broadcast");
        expect(calls).not.toContain("sign");
        expect(filled.gasUsed).toBe(42_000n);
    });

    it("never sends twice for the same order", async () => {
        const journal = new MemoryJournal();
        const first = fakeChain();
        await executorWith(first.chain, journal).fill(order, quote, "p1:0");

        const second = fakeChain();
        await executorWith(second.chain, journal).fill(order, quote, "p1:0");
        expect(second.calls).not.toContain("sign");
        expect(second.calls).not.toContain("broadcast");
    });

    it("sends nothing when the simulation says it would revert", async () => {
        const journal = new MemoryJournal();
        const { chain, calls } = fakeChain({ failAt: "simulate" });
        await expect(executorWith(chain, journal).fill(order, quote, "p1:0"))
            .rejects.toThrow(/INSUFFICIENT_OUTPUT_AMOUNT/);
        expect(calls).not.toContain("sign");
        // the claim is released, so a refusal before signing does not eat the spend cap
        expect(await journal.find("p1:0")).toBe(null);
        expect(await journal.committedUsdcMinor()).toBe(0n);
    });

    it("refuses to retry an order the chain already rejected", async () => {
        const journal = new MemoryJournal();
        const reverting = fakeChain({ waitFor: async () => ({ status: "reverted", gasUsed: 21_000n }) });
        await expect(executorWith(reverting.chain, journal).fill(order, quote, "p1:0")).rejects.toThrow(/reverted/);
        expect((await journal.find("p1:0"))?.status).toBe("failed");

        const retry = fakeChain();
        await expect(executorWith(retry.chain, journal).fill(order, quote, "p1:0"))
            .rejects.toThrow(/already failed/);
        expect(retry.calls).not.toContain("sign");
    });

    it("counts the cap from the journal, so it is one cap across instances", async () => {
        const journal = new MemoryJournal();
        const { chain } = fakeChain();
        // another instance already committed most of the cap
        await journal.reserve({ key: "other:0", symbol: "AAPLc", asset: order.asset, usdcInMinor: u("19.50") });

        const ex = executorWith(chain, journal);
        expect((await ex.budget()).remaining).toBe(u("0.50"));
        await expect(ex.fill(order, quote, "p1:0")).rejects.toThrow(/spend cap/);
    });

    it("checks everything a real swap needs, and sends nothing", async () => {
        // not a separate implementation: the same calldata through the same code, asking the chain the
        // same question, so what it reports is what would happen
        const journal = new MemoryJournal();
        const { chain, calls } = fakeChain();
        const result = await executorWith(chain, journal).preflight(order, quote);

        expect(result.ok).toBe(true);
        expect(result.checks.map((c) => c.name))
            .toEqual(["network", "spend cap", "USDC", "gas", "calldata", "allowance", "simulation"]);
        expect(calls).not.toContain("sign");
        expect(calls).not.toContain("broadcast");
        expect(await journal.find("p1:0")).toBe(null); // nothing claimed, nothing committed
    });

    it("says which check failed rather than that it is not ready", async () => {
        const journal = new MemoryJournal();
        const poor = fakeChain({
            readUsdc: async (fn) => (fn === "balanceOf" ? u("0.10") : u("1000.00")),
            nativeBalance: async () => 0n,
        });
        const result = await executorWith(poor.chain, journal).preflight(order, quote);

        expect(result.ok).toBe(false);
        const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
        expect(failed).toContain("USDC");
        expect(failed).toContain("gas");
        expect(result.checks.find((c) => c.name === "gas")?.detail).toMatch(/no ETH/);
    });

    it("refuses to proceed when the RPC is pointed at the wrong chain", async () => {
        const journal = new MemoryJournal();
        const wrong = fakeChain({ chainId: async () => 1 });
        const result = await executorWith(wrong.chain, journal).preflight(order, quote);
        expect(result.ok).toBe(false);
        expect(result.checks[0]!.detail).toMatch(/chain 1, expected 8453/);
        expect(result.checks.length).toBe(1); // nothing else is worth checking
    });

    it("resolves what it left behind when it starts again", async () => {
        const journal = new MemoryJournal();
        await journal.reserve({ key: "p1:0", symbol: "NVDAc", asset: order.asset, usdcInMinor: u("1.00") });
        await journal.recordSigned("p1:0", HASH, RAW);

        const { chain } = fakeChain({ receiptFor: async () => ({ status: "success", gasUsed: 30_000n }) });
        const resolved = await executorWith(chain, journal).recover();
        expect(resolved).toEqual([{ key: "p1:0", outcome: "filled" }]);
        expect((await journal.find("p1:0"))?.status).toBe("filled");
    });
});
