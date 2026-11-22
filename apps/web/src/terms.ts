import type { MandateTerms, TermsUpdate } from "./api";

/**
 * Turning the owner's typing into mandate terms, without a float touching money.
 *
 * Basis points are the unit at the API boundary and percent is the unit a person thinks in, so the
 * conversion happens here and only here. It is done on the digits of the string rather than with
 * arithmetic on a parsed number: 0.07 percent through a float is 6.999999999999999 bps, and a limit on
 * someone's money is the last place to discover that.
 *
 * Amounts never convert at all. They are decimal strings in the form and decimal strings on the wire,
 * validated against the same shape the server accepts.
 */

/** Percent as typed, to integer basis points. Null when it is not a percent with at most 2 decimals. */
export function percentToBps(input: string): number | null {
    const raw = input.trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
    const [whole, frac = ""] = raw.split(".");
    const bps = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
    return bps > 10_000 ? null : bps;
}

/** Basis points as a percent string, trailing zeros trimmed so 4000 reads as "40" and not "40.00". */
export function bpsToPercent(bps: number): string {
    const whole = Math.trunc(bps / 100);
    // every trailing zero, not just one: 4000 bps is "40", never "40.0"
    const frac = String(Math.abs(bps % 100)).padStart(2, "0").replace(/0+$/, "");
    return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/** The amount shape the server accepts. Checked here so the form can say so before sending. */
export const AMOUNT = /^\d+(\.\d{1,6})?$/;

export function isAmount(input: string): boolean {
    return AMOUNT.test(input.trim());
}

/** A whole number of seconds, as a positive integer. */
export function toSeconds(input: string): number | null {
    const raw = input.trim();
    if (!/^\d{1,7}$/.test(raw)) return null;
    const n = Number(raw);
    return n > 0 ? n : null;
}

/** Addresses one per line, trimmed. Empty lines dropped; validity is the server's to judge. */
export function parseAddresses(raw: string): string[] {
    return raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

export function formatAddresses(addresses: readonly string[]): string {
    return addresses.join("\n");
}

/** "id 50" or "id: 50" per line, the percent being the theme's target. */
export function parseThemeTargets(raw: string): { id: string; targetBps: number }[] | null {
    const out: { id: string; targetBps: number }[] = [];
    for (const line of raw.split("\n")) {
        const text = line.trim();
        if (text === "") continue;
        const m = /^(.+?)[\s:]+(\d{1,3}(?:\.\d{1,2})?)$/.exec(text);
        if (m === null) return null;
        const bps = percentToBps(m[2]!);
        if (bps === null || bps < 1) return null;
        out.push({ id: m[1]!.trim(), targetBps: bps });
    }
    return out.length === 0 ? null : out;
}

export function formatThemeTargets(themes: readonly { id: string; targetBps: number }[]): string {
    return themes.map((t) => `${t.id} ${bpsToPercent(t.targetBps)}`).join("\n");
}

/**
 * Only what actually changed.
 *
 * The server carries over every term an update does not mention, so sending the whole form back would
 * be harmless but dishonest: the response names what changed, and it would then name terms the owner
 * never touched. Sending the difference keeps that list true.
 */
export function changedOnly(before: MandateTerms, after: MandateTerms): TermsUpdate {
    const out: TermsUpdate = {};
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    if (!same(before.eligible, after.eligible)) out.eligible = after.eligible;
    if (!same(before.themes, after.themes)) out.themes = after.themes;
    for (const k of [
        "maxCompanyBps", "investShareBps", "maxSlippageBps", "driftToleranceBps", "approvalExpirySeconds",
    ] as const) {
        if (before[k] !== after[k]) out[k] = after[k];
    }
    for (const k of ["maxTradeUsdc", "minTradeUsdc", "reserveTargetUsdc"] as const) {
        if (before[k] !== after[k]) out[k] = after[k];
    }
    if (before.investOnlyWhenAhead !== after.investOnlyWhenAhead && after.investOnlyWhenAhead !== undefined) {
        out.investOnlyWhenAhead = after.investOnlyWhenAhead;
    }
    return out;
}

/** How a change reads in the review, in the units the owner typed rather than the units sent. */
export function describeChange(key: keyof MandateTerms, before: MandateTerms, after: MandateTerms): string {
    const bps = (v: number): string => `${bpsToPercent(v)}%`;
    switch (key) {
        case "eligible":
            return `Eligible tokens: ${before.eligible.length} → ${after.eligible.length}`;
        case "themes":
            return `Themes: ${before.themes.map((t) => `${t.id} ${bps(t.targetBps)}`).join(", ")} → ${after.themes.map((t) => `${t.id} ${bps(t.targetBps)}`).join(", ")}`;
        case "approvalExpirySeconds":
            return `Approval expiry: ${before.approvalExpirySeconds}s → ${after.approvalExpirySeconds}s`;
        case "investOnlyWhenAhead":
            return `Invest only when ahead: ${before.investOnlyWhenAhead === true ? "yes" : "no"} → ${after.investOnlyWhenAhead === true ? "yes" : "no"}`;
        case "maxTradeUsdc":
        case "minTradeUsdc":
        case "reserveTargetUsdc":
            return `${LABELS[key]}: ${before[key]} → ${after[key]} USDC`;
        default:
            return `${LABELS[key]}: ${bps(before[key])} → ${bps(after[key])}`;
    }
}

export const LABELS: Record<keyof MandateTerms, string> = {
    eligible: "Eligible tokens",
    themes: "Themes",
    maxCompanyBps: "Most in any one company",
    investShareBps: "Share of surplus to invest",
    maxSlippageBps: "Most slippage allowed",
    driftToleranceBps: "Price drift before reapproval",
    approvalExpirySeconds: "Approval expiry",
    maxTradeUsdc: "Largest single trade",
    minTradeUsdc: "Smallest trade worth making",
    reserveTargetUsdc: "Protected reserve",
    investOnlyWhenAhead: "Invest only when ahead",
};
