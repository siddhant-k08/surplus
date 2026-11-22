import { describe, it, expect, vi } from "vitest";
import { log, redact, errorFields } from "../src/log";

describe("what reaches the logs", () => {
    it("keeps credentials out of them", () => {
        // error messages are the usual culprit: a driver that cannot connect includes the whole
        // connection string, and a log drain is a copy of that in someone else's system
        expect(redact("connect failed for postgresql://neondb_owner:npg_secret123@ep-x.neon.tech/db"))
            .toBe("connect failed for postgresql://neondb_owner:REDACTED@ep-x.neon.tech/db");

        expect(redact(`EXECUTION_PRIVATE_KEY=0x${"ab".repeat(32)}`)).toBe("EXECUTION_PRIVATE_KEY=REDACTED");
        expect(redact("Authorization: Bearer sk-abc123")).toBe("Authorization: Bearer REDACTED");
        expect(redact("api_key: AIzaSyExample")).toBe("api_key: REDACTED");
    });

    it("leaves a transaction hash alone, because that is public and the point", () => {
        // A private key and a settlement hash are both 32 bytes of hex. Masking by shape would destroy
        // the one field these logs exist to carry: the transaction of a sale that could not be written
        // down is what makes it recoverable by hand.
        const tx = "0x" + "cd".repeat(32);
        expect(redact(`booked a sale in ${tx}`)).toBe(`booked a sale in ${tx}`);
    });

    it("writes one line of JSON with a stable event name and a readable message", () => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
        try {
            log.info("sale_booked", "booked 0.010000 USDC", { amountUsdcMinor: "10000", briefId: "brief-1" });
        } finally {
            spy.mockRestore();
        }
        const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(parsed.event).toBe("sale_booked");
        expect(parsed.level).toBe("info");
        expect(parsed.message).toBe("booked 0.010000 USDC");
        expect(parsed.amountUsdcMinor).toBe("10000");
        expect(typeof parsed.ts).toBe("string");
    });

    it("drops undefined fields rather than writing nulls nobody can read", () => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, "warn").mockImplementation((l: unknown) => void lines.push(String(l)));
        try {
            log.warn("thing", "a thing happened", { present: "yes", missing: undefined });
        } finally {
            spy.mockRestore();
        }
        const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(parsed.present).toBe("yes");
        expect("missing" in parsed).toBe(false);
    });

    it("turns an error into fields without its object graph", () => {
        const f = errorFields(new Error("connect ECONNREFUSED postgresql://u:p@h/db"));
        expect(f.errorType).toBe("Error");
        expect(String(f.error)).toContain("REDACTED");
        expect(String(f.error)).not.toContain(":p@");
    });
});
