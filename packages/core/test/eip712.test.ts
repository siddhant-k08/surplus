import { describe, it, expect } from "vitest";
import {
    APPROVAL_TYPES,
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
});
