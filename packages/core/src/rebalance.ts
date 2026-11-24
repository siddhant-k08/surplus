import { mulBps } from "./money";
import type { MandateTerms } from "./mandate";
import { NO_THEME, themeKey, type ThemeHolding } from "./positions";

/**
 * Which themes have drifted above their target weight, and by how much.
 *
 * The mandate's `targetBps` are shares of money being invested. Prices then move them: a theme that
 * doubles while another stays flat ends up a larger part of the portfolio than the owner asked for,
 * and nothing in the buy path ever corrects that, because the allocator only decides where *new*
 * surplus goes. This is the correction, and it only ever sells.
 *
 * Two decisions worth stating, because the answer changes completely with either.
 *
 * **The denominator is the portfolio, not the portfolio plus idle cash.** A theme's weight is its share
 * of what is actually held. Including uninvested surplus would make every theme look under-weight
 * whenever cash was waiting, so a rebalance would never trim anything and the rule would be inert in
 * exactly the situation it exists for.
 *
 * **Targets are renormalised over the themes that actually hold something.** A theme the research found
 * nothing for holds nothing, and its target is left uninvested by the allocator rather than shared out.
 * Counting that target in the denominator would make every funded theme look permanently over-weight
 * and trigger trims that do nothing but move money out of the portfolio into idle cash. With targets of
 * 50/30/20 and nothing held in the third, the first two are on target at 62.5/37.5, not over it.
 */

export interface ThemeWeight {
    theme: string;
    /** What this theme's holdings are worth now, in USDC minor units. */
    valueUsdc: bigint;
    /** Share of the portfolio, in basis points. */
    actualBps: number;
    /** Share the mandate asks for, renormalised over themes that hold something. */
    targetBps: number;
    /** Positive when above target. */
    driftBps: number;
    /** USDC minor units that would have to be sold to bring this theme back to its target. */
    excessUsdc: bigint;
    /** True when the drift is beyond the mandate's band and the excess is worth selling. */
    overBand: boolean;
}

export interface Drift {
    /** Every theme that holds something, biggest drift first. */
    themes: ThemeWeight[];
    totalUsdc: bigint;
    /** Holdings under no theme, which belong to no target and are never trimmed. */
    untargetedUsdc: bigint;
}

export interface DriftInput {
    holdings: readonly ThemeHolding[];
    /** USDC minor units per one whole token. */
    prices: ReadonlyMap<string, bigint>;
    decimals: ReadonlyMap<string, number>;
    terms: MandateTerms;
}

/** What one holding is worth now, or null when it cannot be priced. */
function value(h: ThemeHolding, prices: ReadonlyMap<string, bigint>, decimals: ReadonlyMap<string, number>): bigint | null {
    const price = prices.get(h.asset);
    const dec = decimals.get(h.asset);
    if (price === undefined || dec === undefined || price <= 0n || h.units <= 0n) return null;
    return (h.units * price) / 10n ** BigInt(dec);
}

export function themeDrift(i: DriftInput): Drift {
    const targets = new Map(i.terms.themes.map((t) => [t.id, t.targetBps]));

    // What each theme is worth now. A holding that cannot be priced is left out of both the theme and
    // the total, so a missing quote never silently makes a theme look smaller than it is.
    const valueByTheme = new Map<string, bigint>();
    let untargetedUsdc = 0n;
    for (const h of i.holdings) {
        const worth = value(h, i.prices, i.decimals);
        if (worth === null) continue;
        const key = themeKey(h.theme);
        if (key === NO_THEME || !targets.has(key)) {
            untargetedUsdc += worth;
            continue;
        }
        valueByTheme.set(key, (valueByTheme.get(key) ?? 0n) + worth);
    }

    const totalUsdc = [...valueByTheme.values()].reduce((a, v) => a + v, 0n);
    if (totalUsdc <= 0n) return { themes: [], totalUsdc: 0n, untargetedUsdc };

    // Renormalised over the themes that actually hold something: see the note at the top of this file.
    const liveTargetTotal = [...valueByTheme.keys()].reduce((a, id) => a + (targets.get(id) ?? 0), 0);
    const band = i.terms.rebalanceBandBps;

    const themes: ThemeWeight[] = [];
    for (const [theme, valueUsdc] of valueByTheme) {
        const targetBps = liveTargetTotal === 0 ? 0 : Math.round(((targets.get(theme) ?? 0) * 10_000) / liveTargetTotal);
        const actualBps = Number((valueUsdc * 10_000n) / totalUsdc);
        const driftBps = actualBps - targetBps;
        // What is above target, in money. Rounded down, so a trim never takes a theme below its target.
        const onTarget = mulBps(totalUsdc, targetBps);
        const excessUsdc = valueUsdc > onTarget ? valueUsdc - onTarget : 0n;
        themes.push({
            theme,
            valueUsdc,
            actualBps,
            targetBps,
            driftBps,
            excessUsdc,
            overBand: band !== undefined && driftBps > band && excessUsdc >= i.terms.minTradeUsdc,
        });
    }

    themes.sort((a, b) => b.driftBps - a.driftBps);
    return { themes, totalUsdc, untargetedUsdc };
}
