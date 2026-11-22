import { describe, it, expect } from "vitest";
import { toSignableJson, chainIdFromCaip } from "../src/wallet";
import { describePaymentFailure, checkPaymentSignature } from "../src/buy";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The browser code had no tests, and three signing bugs in a row lived in it. These cover the parts
 * that are pure logic, which is where the bugs were.
 */
describe("toSignableJson", () => {
    it("serialises an EIP-3009 authorisation, whose amounts are bigints", () => {
        // the shape @x402/evm hands the signer
        const payload = {
            domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036C" },
            types: { TransferWithAuthorization: [{ name: "value", type: "uint256" }] },
            primaryType: "TransferWithAuthorization",
            message: {
                from: "0x8Ab8",
                to: "0xc0cB",
                value: 10000n,
                validAfter: 0n,
                validBefore: 1795000000n,
                nonce: "0xdead",
            },
        };
        const json = JSON.parse(toSignableJson(payload)) as { message: Record<string, unknown> };
        expect(json.message.value).toBe("10000");
        expect(json.message.validAfter).toBe("0");
        expect(json.message.validBefore).toBe("1795000000");
    });

    it("does not round a value too large for a double", () => {
        const big = 2n ** 70n + 1n;
        const json = JSON.parse(toSignableJson({ v: big })) as { v: string };
        expect(json.v).toBe(big.toString());
        expect(BigInt(json.v)).toBe(big);
    });

    it("leaves everything that is not a bigint alone", () => {
        const json = toSignableJson({ a: "1", b: 2, c: true, d: null, e: [1, "2"] });
        expect(json).toBe('{"a":"1","b":2,"c":true,"d":null,"e":[1,"2"]}');
    });
});

describe("chainIdFromCaip", () => {
    it("reads an eip155 chain id", () => {
        expect(chainIdFromCaip("eip155:84532")).toBe(84532);
        expect(chainIdFromCaip(" eip155:8453 ")).toBe(8453);
    });

    it("refuses anything else rather than guessing a chain", () => {
        expect(chainIdFromCaip("base-sepolia")).toBeNull();
        expect(chainIdFromCaip("solana:x")).toBeNull();
        expect(chainIdFromCaip("eip155:")).toBeNull();
    });
});

describe("describePaymentFailure", () => {
    it("never tells a timed-out buyer to try again", () => {
        const msg = describePaymentFailure(502, "Facilitator supported request timed out after 90000ms");
        // the money may already have moved, so the only safe next step is checking the receipts
        expect(msg).toContain("Lost your link?");
        expect(msg).not.toMatch(/try again/i);
        expect(msg).not.toMatch(/nothing was charged/i);
    });

    it("says nothing was charged only when nothing was", () => {
        const msg = describePaymentFailure(402, "insufficient_balance");
        expect(msg).toContain("nothing was charged");
    });

    it("passes a verdict from the server through", () => {
        expect(describePaymentFailure(402, "invalid_signature")).toBe("The payment was not accepted: invalid_signature");
        expect(describePaymentFailure(400, "themes were not accepted")).toBe("themes were not accepted");
        expect(describePaymentFailure(500, "boom")).toBe("The purchase failed (500): boom");
    });
});

// a throwaway test key, the first of Anvil's standard accounts
const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const other = "0x0000000000000000000000000000000000001234";

const authorization = (from: string, validBefore: number) => ({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    types: {
        TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
        ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
        from,
        to: "0xc0cB2732A63a5F91F17A2E657F1A8f1B56b33F3a",
        value: "10000",
        validAfter: "0",
        validBefore: String(validBefore),
        nonce: `0x${"d5".repeat(32)}`,
    },
});

describe("checkPaymentSignature", () => {
    const soon = Math.floor(Date.now() / 1000) + 300;

    it("accepts a signature from the account the payment pays from", async () => {
        const td = authorization(signer.address, soon);
        const sig = await signer.signTypedData(td as never);
        await expect(checkPaymentSignature(td, sig, signer.address)).resolves.toBeUndefined();
    });

    it("refuses a signature from a different account, naming both", async () => {
        // the wallet offered `other` but signed with its own key: the facilitator would only say
        // "invalid_exact_evm_signature", so this is where it has to be caught
        const td = authorization(other, soon);
        const sig = await signer.signTypedData(td as never);
        await expect(checkPaymentSignature(td, sig, other)).rejects.toThrow(/signed as 0x/i);
        await expect(checkPaymentSignature(td, sig, other)).rejects.toThrow(/Nothing was charged/);
    });

    it("refuses an authorisation that expired while it waited to be approved", async () => {
        const td = authorization(signer.address, Math.floor(Date.now() / 1000) - 1);
        const sig = await signer.signTypedData(td as never);
        await expect(checkPaymentSignature(td, sig, signer.address)).rejects.toThrow(/expired while it waited/);
    });

    it("leaves typed data it does not recognise alone", async () => {
        const login = { domain: {}, types: { Login: [{ name: "nonce", type: "string" }] }, primaryType: "Login", message: { nonce: "x" } };
        await expect(checkPaymentSignature(login, "0x00", "0x0")).resolves.toBeUndefined();
    });
});

describe("describePaymentFailure, signature rejection", () => {
    it("explains the two causes a buyer can act on", () => {
        const msg = describePaymentFailure(402, "invalid_exact_evm_signature");
        expect(msg).toMatch(/different account/);
        expect(msg).toMatch(/second wallet/);
        expect(msg).toContain("nothing was charged");
    });
});
