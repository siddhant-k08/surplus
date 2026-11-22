import { describe, it, expect } from "vitest";
import { hashTypedData, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    APPROVAL_TYPES,
    EIP712_DOMAIN_TYPE,
    approvalDomain,
    approvalMessage,
    approvalTypedData,
    approvalTypedDataJson,
} from "../src/eip712";
import { parseUsdc as u } from "../src/money";
import type { Approval } from "../src/approval";

const approval: Approval = {
    proposalHash: "a".repeat(64),
    mandateVersion: 2,
    mandateHash: "b".repeat(64),
    maxUsdcIn: u("1.239406"),
    expiresAt: "2026-11-21T00:10:00.000Z",
};

describe("approval typed data", () => {
    it("binds the proposal, the mandate, the ceiling and the expiry", () => {
        const m = approvalMessage(approval);
        expect(m.proposalHash).toBe(`0x${"a".repeat(64)}`);
        expect(m.mandateHash).toBe(`0x${"b".repeat(64)}`);
        expect(m.mandateVersion).toBe(2n);
        expect(m.maxUsdcIn).toBe(u("1.239406"));
        expect(m.expiresAt).toBe(BigInt(Date.parse("2026-11-21T00:10:00.000Z") / 1000));
        // every field of the approval is covered by the signed type
        expect(APPROVAL_TYPES.Approval.map((f) => f.name).sort())
            .toEqual(["expiresAt", "mandateHash", "mandateVersion", "maxUsdcIn", "proposalHash"]);
    });

    it("puts the chain id in the domain, so a testnet signature is not valid on mainnet", () => {
        expect(approvalDomain(84532).chainId).toBe(84532);
        expect(approvalTypedData(approval, 8453).domain.chainId).toBe(8453);
        expect(approvalTypedData(approval, 84532)).not.toEqual(approvalTypedData(approval, 8453));
        expect(() => approvalDomain(0)).toThrow(/positive integer/);
    });

    it("accepts a hash with or without the 0x prefix and lowercases it", () => {
        const withPrefix = approvalMessage({ ...approval, proposalHash: `0x${"A".repeat(64)}` });
        expect(withPrefix.proposalHash).toBe(`0x${"a".repeat(64)}`);
    });

    it("refuses a malformed hash, version or amount rather than signing nonsense", () => {
        expect(() => approvalMessage({ ...approval, proposalHash: "short" })).toThrow(/32 byte hex/);
        expect(() => approvalMessage({ ...approval, mandateVersion: 0 })).toThrow(/positive integer/);
        expect(() => approvalMessage({ ...approval, maxUsdcIn: -1n })).toThrow(/must not be negative/);
        expect(() => approvalMessage({ ...approval, expiresAt: "whenever" })).toThrow(/not a date/);
    });

    it("changes the message when any bound field changes", () => {
        const base = JSON.stringify(approvalTypedDataJson(approval, 84532));
        const variants: Approval[] = [
            { ...approval, proposalHash: "c".repeat(64) },
            { ...approval, mandateVersion: 3 },
            { ...approval, mandateHash: "d".repeat(64) },
            { ...approval, maxUsdcIn: approval.maxUsdcIn + 1n },
            { ...approval, expiresAt: "2026-11-21T00:20:00.000Z" },
        ];
        for (const v of variants) {
            expect(JSON.stringify(approvalTypedDataJson(v, 84532))).not.toBe(base);
        }
    });

    it("renders JSON with amounts as strings, so a wallet never sees a float", () => {
        const json = approvalTypedDataJson(approval, 84532) as { message: Record<string, string> };
        expect(json.message.maxUsdcIn).toBe("1239406");
        expect(json.message.mandateVersion).toBe("2");
        expect(typeof json.message.expiresAt).toBe("string");
    });
    // The wallet payload declares the domain type; the server's own verification leaves viem to infer it.
    // These tests pin the two to the same signature, because a drift between them would look exactly like
    // a wallet that signed the wrong thing: a rejected signature with nothing to point at.
    it("declares the domain type for a wallet, which viem infers for itself", () => {
        const json = approvalTypedDataJson(approval, 84532) as { types: Record<string, unknown> };
        expect(json.types.EIP712Domain).toEqual(EIP712_DOMAIN_TYPE);
        expect(json.types.Approval).toEqual(APPROVAL_TYPES.Approval);
    });

    it("declares exactly the domain's own fields, in order", () => {
        const domain = approvalDomain(84532);
        expect(EIP712_DOMAIN_TYPE.map((f) => f.name)).toEqual(Object.keys(domain));
    });

    it("hashes the same with the domain type declared as without it", () => {
        const td = approvalTypedData(approval, 84532);
        const withDomain = {
            ...td,
            types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...td.types },
        };
        expect(hashTypedData(withDomain as never)).toBe(hashTypedData(td as never));
    });

    it("accepts a signature made over the wallet payload", async () => {
        // a throwaway test key, the first of Anvil's standard accounts
        const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        const td = approvalTypedData(approval, 84532);
        const signature = await signer.signTypedData({
            ...td,
            types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...td.types },
        } as never);
        // verified against the payload the server builds, which carries no EIP712Domain entry
        expect(await verifyTypedData({ address: signer.address, signature, ...(td as object) } as never)).toBe(true);
    });
});
