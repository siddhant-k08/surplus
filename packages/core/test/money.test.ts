import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseUsdc, formatUsdc, mulBps } from "../src/money";

describe("money", () => {
  it("parses whole and fractional amounts", () => {
    expect(parseUsdc("3")).toBe(3_000_000n);
    expect(parseUsdc("1.90")).toBe(1_900_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("-0.5")).toBe(-500_000n);
  });

  it("rejects malformed input", () => {
    expect(() => parseUsdc("1.1234567")).toThrow();
    expect(() => parseUsdc("abc")).toThrow();
    expect(() => parseUsdc("")).toThrow();
  });

  it("formats with six decimals", () => {
    expect(formatUsdc(1_900_000n)).toBe("1.900000");
    expect(formatUsdc(-1n)).toBe("-0.000001");
    expect(formatUsdc(0n)).toBe("0.000000");
  });

  it("round-trips any amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (x) => {
        expect(parseUsdc(formatUsdc(x))).toBe(x);
      }),
    );
  });

  it("mulBps rounds down", () => {
    expect(mulBps(1_900_000n, 5_000)).toBe(950_000n);
    expect(mulBps(1n, 5_000)).toBe(0n);
  });

  it("mulBps rejects invalid bps", () => {
    expect(() => mulBps(1n, 10_001)).toThrow();
    expect(() => mulBps(1n, 1.5)).toThrow();
  });
});