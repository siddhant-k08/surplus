export const USDC_DECIMALS = 6;
const ONE = 1_000_000n;

/** Parse a decimal string like "1.90" into minor units (1.90 USDC = 1_900_000n). */
export function parseUsdc(input: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid USDC amount: "${input}"`);
  const neg = m[1] === "-";
  const whole = m[2] ?? "0";
  const frac = m[3] ?? "";
  const minor = BigInt(whole) * ONE + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
  return neg ? -minor : minor;
}

/** Format minor units as a string with exactly six decimals. */
export function formatUsdc(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(USDC_DECIMALS, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** amount * bps / 10_000, rounded down. Amounts must be non-negative. */
export function mulBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`bps must be an integer from 0 to 10000, got ${bps}`);
  }
  if (amount < 0n) throw new Error("mulBps requires a non-negative amount");
  return (amount * BigInt(bps)) / 10_000n;
}