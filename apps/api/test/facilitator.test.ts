import { describe, it, expect } from "vitest";
import { openFacilitator, openLocalFacilitator } from "../src/facilitator";
import { loadConfig, BASE_SEPOLIA, BASE_MAINNET } from "../src/config";

/**
 * Who settles, and the two keys that must never be the same one.
 *
 * The free facilitator serves Base Sepolia only, so with it the agent can earn nothing the investing
 * half can spend: the tokenized stocks are on Base mainnet. Settling in process is the route to mainnet
 * revenue without a paid provider, and it is also the only part of this system that spends gas on
 * someone else's behalf, so what it refuses to do matters as much as what it does.
 */

const KEY_A = "0x" + "11".repeat(32);
const KEY_B = "0x" + "22".repeat(32);
const RPC = "https://base-sepolia.example/rpc";

const config = (over: NodeJS.ProcessEnv = {}) => loadConfig({
    X402_PAY_TO: "0x" + "a".repeat(40),
    OWNER_TOKEN: "owner-token-for-tests-only",
    OWNER_ADDRESS: "0x" + "9".repeat(40),
    ...over,
} as NodeJS.ProcessEnv);

const localEnv = (over: Partial<Parameters<typeof openLocalFacilitator>[1]> = {}) => ({
    rpcUrl: RPC,
    privateKey: KEY_A,
    executionKey: KEY_B,
    confirmationTimeoutMs: 15_000,
    ...over,
});

describe("choosing who settles", () => {
    it("uses the hosted facilitator unless asked not to", () => {
        // The default must not move: every sale so far settled through it, and switching the thing that
        // moves a buyer's money by omission is not a change anyone asked for.
        const choice = openFacilitator(config(), {} as NodeJS.ProcessEnv);
        expect(choice.kind).toBe("hosted");
        expect(choice.detail).toBe("https://x402.org/facilitator");
        expect(choice.address).toBeUndefined();
    });

    it("settles in process when asked, and says which address pays the gas", () => {
        const choice = openFacilitator(config(), {
            X402_FACILITATOR: "local",
            BASE_SEPOLIA_RPC_URL: RPC,
            FACILITATOR_PRIVATE_KEY: KEY_A,
            EXECUTION_PRIVATE_KEY: KEY_B,
        } as NodeJS.ProcessEnv);
        expect(choice.kind).toBe("local");
        expect(choice.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(choice.detail).toContain(choice.address!);
        expect(choice.detail).toContain(BASE_SEPOLIA);
    });

    it("takes its own RPC, because the trading one is on a different chain", () => {
        // BASE_RPC_URL belongs to the executor, which swaps tokenized stocks and so is always on Base
        // mainnet. While the agent sells on Sepolia and trades on mainnet, one variable cannot be both.
        const choice = openFacilitator(config(), {
            X402_FACILITATOR: "local",
            FACILITATOR_RPC_URL: RPC,
            BASE_RPC_URL: "https://mainnet.example/rpc",
            FACILITATOR_PRIVATE_KEY: KEY_A,
        } as NodeJS.ProcessEnv);
        expect(choice.kind).toBe("local");
        expect(choice.verifyChain).toBeTypeOf("function");
    });

    it("takes the RPC named after the chain it is serving", () => {
        const choice = openFacilitator(config(), {
            X402_FACILITATOR: "local",
            BASE_SEPOLIA_RPC_URL: RPC,
            FACILITATOR_PRIVATE_KEY: KEY_A,
        } as NodeJS.ProcessEnv);
        expect(choice.kind).toBe("local");
    });

    it("refuses to start rather than quietly falling back to someone else's server", () => {
        // A deployment that asked to settle its own payments and silently handed them to a third party
        // is the kind of surprise that makes every other guarantee here worth less.
        expect(() => openFacilitator(config(), {
            X402_FACILITATOR: "local",
            FACILITATOR_PRIVATE_KEY: KEY_A,
        } as NodeJS.ProcessEnv)).toThrow(/cannot settle payments: no RPC url is set for eip155:84532/);
    });
});

describe("building the local facilitator", () => {
    it("refuses the trading key as the settlement key", () => {
        // Different jobs, different blast radii: this wallet pays other people's gas and publishes its
        // address, the other one spends the agent's own USDC.
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv({ executionKey: KEY_A }));
        expect(r.client).toBeNull();
        expect("why" in r && r.why).toMatch(/must not be the same key/);
    });

    it("compares the two keys without caring about hex case", () => {
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv({
            privateKey: "0x" + "AB".repeat(32),
            executionKey: "0x" + "ab".repeat(32),
        }));
        expect(r.client).toBeNull();
    });

    it("allows the settlement key when no trading key is set at all", () => {
        // Fills are simulated until mainnet is enabled, so there is often no trading key to clash with.
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv({ executionKey: "" }));
        expect(r.client).not.toBeNull();
    });

    it("refuses a key that is not a 32 byte hex key", () => {
        expect(openLocalFacilitator(BASE_SEPOLIA, localEnv({ privateKey: "" })).client).toBeNull();
        expect(openLocalFacilitator(BASE_SEPOLIA, localEnv({ privateKey: "hunter2" })).client).toBeNull();
        expect(openLocalFacilitator(BASE_SEPOLIA, localEnv({ privateKey: "0x" + "11".repeat(16) })).client).toBeNull();
    });

    it("refuses a network it has no chain for", () => {
        const r = openLocalFacilitator("eip155:1", localEnv());
        expect(r.client).toBeNull();
        expect("why" in r && r.why).toMatch(/no viem chain/);
    });

    it("serves Base mainnet, which is the whole point of self-hosting", () => {
        // The free facilitator advertises eip155:84532 and nothing else, so mainnet revenue is
        // unreachable through it at any price. This is the route that does not need a paid provider.
        const r = openLocalFacilitator(BASE_MAINNET, localEnv());
        expect(r.client).not.toBeNull();
    });

    it("answers getSupported for the network it was built for", () => {
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv());
        expect(r.client).not.toBeNull();
        if (r.client === null) return;
        const supported = r.client.getSupported();
        expect(supported.kinds.some((k) => k.network === BASE_SEPOLIA && k.scheme === "exact")).toBe(true);
    });

    it("refuses to settle a network this wallet has no RPC for", async () => {
        /*
         * registerExactEvmScheme also registers the v1 scheme across every EVM network the package
         * knows, so getSupported advertises polygon, celo, monad and twenty more. The resource server
         * names one network in its 402 challenge, but the facilitator takes whatever payload it is
         * handed and this wallet pays the gas, so the guard is what keeps that surface honest.
         */
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv());
        if (r.client === null) return;
        const payload = { x402Version: 2, scheme: "exact", network: "eip155:137" } as never;
        const requirements = { scheme: "exact", network: "eip155:137" } as never;

        const settled = await r.client.settle(payload, requirements);
        expect(settled.success).toBe(false);

        const verified = await r.client.verify(payload, requirements);
        expect(verified.isValid).toBe(false);
    });

    it("still settles the network it was built for", async () => {
        // The guard must refuse the others without refusing the one that matters. A real payload would
        // reach the chain, so this only proves the hook did not abort it on the network check.
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv());
        if (r.client === null) return;
        const verified = await r.client.verify(
            { x402Version: 2, scheme: "exact", network: BASE_SEPOLIA } as never,
            { scheme: "exact", network: BASE_SEPOLIA } as never,
        );
        expect(String(verified.invalidReason ?? "")).not.toContain("settles eip155:84532 only");
    });

    it("exposes verify, settle and getSupported, which is all the resource server asks for", () => {
        const r = openLocalFacilitator(BASE_SEPOLIA, localEnv());
        if (r.client === null) return;
        for (const method of ["verify", "settle", "getSupported"] as const) {
            expect(typeof r.client[method]).toBe("function");
        }
    });
});
