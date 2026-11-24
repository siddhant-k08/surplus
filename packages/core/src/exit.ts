import { formatUsdc } from "./money";
import { validateTerms, type MandateTerms } from "./mandate";
import {
    NO_THEME, costOfUnits, holdingOf, partlyUnrecorded, themeKey, unsellable,
    type Position, type ThemeHolding,
} from "./positions";
import { themeDrift, type Drift } from "./rebalance";
import type { Leg } from "./policy";

/**
 * When the agent sells, and why.
 *
 * The mandate states the exit the same way it states the entry, so the agent never decides for itself
 * when to take money off the table. With no exit term set and nothing requested this returns nothing,
 * which is the correct behaviour for an owner who has not said when to sell: silence is not permission.
 *
 * Every leg is scoped to one theme. The same token is held under several themes at once, and a sale
 * has to say which one it is leaving, or trimming a theme that has drifted would take basis from a
 * theme that was exactly where the mandate wanted it. A whole-position exit is therefore one leg per
 * theme rather than one leg for the token.
 *
 * Nothing here executes anything. It produces legs, which go through the same proposal, policy check,
 * signature and drift gate every buy goes through.
 */

export type ExitReason = "take_profit" | "stop_loss" | "rebalance" | "owner_request";

export interface ExitCandidate {
    asset: string;
    symbol: string;
    theme: string;
    units: bigint;
    /** What the quote says those units are worth now. */
    valueUsdc: bigint;
    costUsdc: bigint;
    moveBps: number;
    reason: ExitReason;
    /** Set when the cost this is measured against covers units that were never recorded. */
    caveat?: string;
}

export interface Skipped {
    asset: string;
    symbol: string;
    /** Said in full, because "the agent did not sell" with no reason is indistinguishable from a bug. */
    why: string;
}

export interface ExitPlan {
    legs: Leg[];
    candidates: ExitCandidate[];
    skipped: Skipped[];
    /** How the portfolio sits against its targets, whether or not anything is being trimmed. */
    drift: Drift;
}

export interface ExitInput {
    /** Asset-level positions, for the price rules, which act on a whole token at a time. */
    positions: ReadonlyMap<string, Position>;
    /** The same money split by theme, which is what a sale actually leaves. */
    holdings: readonly ThemeHolding[];
    /** USDC minor units per one whole token, from a live quote. */
    prices: ReadonlyMap<string, bigint>;
    decimals: ReadonlyMap<string, number>;
    /** Symbol per lowercase address, for messages a person reads. */
    symbols: ReadonlyMap<string, string>;
    terms: MandateTerms;
    /**
     * Exits the owner asked for by name, overriding the price rules.
     *
     * `units` absent means the whole position across every theme holding it. An asset named here is
     * never also evaluated against the rules: the owner asking is the decision, and a second opinion
     * from a threshold would either duplicate the leg or quietly refuse what was asked for.
     */
    requested?: readonly { asset: string; units?: bigint }[];
}

/** Why this position is being sold on price alone, or null to hold it. */
function trigger(moveBps: number, t: MandateTerms): ExitReason | null {
    if (t.takeProfitBps !== undefined && moveBps >= t.takeProfitBps) return "take_profit";
    if (t.stopLossBps !== undefined && moveBps <= -t.stopLossBps) return "stop_loss";
    return null;
}

/** The value and movement of one theme's holding of one token. */
function valueOf(
    held: ThemeHolding,
    price: bigint,
    decimals: number,
): { valueUsdc: bigint; moveBps: number } | null {
    if (held.units <= 0n || held.costUsdcIn <= 0n || price <= 0n) return null;
    const valueUsdc = (held.units * price) / 10n ** BigInt(decimals);
    return { valueUsdc, moveBps: Number(((valueUsdc - held.costUsdcIn) * 10_000n) / held.costUsdcIn) };
}

export function exitPlan(i: ExitInput): ExitPlan {
    validateTerms(i.terms);
    const legs: Leg[] = [];
    const candidates: ExitCandidate[] = [];
    const skipped: Skipped[] = [];
    const asked = new Map((i.requested ?? []).map((r) => [r.asset.toLowerCase(), r]));
    const drift = themeDrift({ holdings: i.holdings, prices: i.prices, decimals: i.decimals, terms: i.terms });

    // What each over-weight theme has to shed, and what it is worth, so every holding inside it can be
    // trimmed by its own share of the excess rather than the first one absorbing all of it.
    const toTrim = new Map<string, { excessUsdc: bigint; valueUsdc: bigint }>();
    for (const t of drift.themes) {
        if (t.overBand) toTrim.set(t.theme, { excessUsdc: t.excessUsdc, valueUsdc: t.valueUsdc });
    }

    const open = i.holdings.filter((h) => h.units > 0n || h.costUsdcIn > 0n);
    for (const held of open) {
        const theme = themeKey(held.theme);
        const symbol = i.symbols.get(held.asset) ?? held.asset;
        const request = asked.get(held.asset);
        const note = (why: string): void => void skipped.push({ asset: held.asset, symbol, why });
        const position = i.positions.get(held.asset);

        const cannot = position === undefined ? "no position" : unsellable(position);
        if (cannot !== null) {
            if (held.costUsdcIn > 0n || request !== undefined) note(cannot);
            continue;
        }

        const price = i.prices.get(held.asset);
        const decimals = i.decimals.get(held.asset);
        if (price === undefined || decimals === undefined) {
            note("no live quote for this token, so what it is worth now is unknown");
            continue;
        }
        const valued = valueOf(held, price, decimals);
        if (valued === null) {
            note(`this ${theme} holding cannot be valued at the quoted price`);
            continue;
        }

        // What to sell, and why. The owner's request wins; then price; then the theme's drift.
        let reason: ExitReason | null = null;
        let units = 0n;
        if (request !== undefined) {
            reason = "owner_request";
            // Named units are a share of the whole token, taken from each theme in proportion, because
            // the owner is naming a position and the books hold it in pieces.
            const whole = i.positions.get(held.asset)!.units;
            units = request.units === undefined
                ? held.units
                : (request.units * held.units) / (whole === 0n ? 1n : whole);
        } else {
            reason = trigger(valued.moveBps, i.terms);
            if (reason !== null) {
                units = held.units;
            } else {
                const trim = toTrim.get(theme);
                if (trim !== undefined && trim.valueUsdc > 0n) {
                    /*
                     * This holding's share of the theme's excess.
                     *
                     * Proportional, so the mix inside the theme is unchanged: a rebalance is about the
                     * theme's weight against the other themes, not about which of its companies to keep.
                     * Taking the whole excess out of the first holding would quietly be a view on that
                     * company, which is not a view the mandate asked the agent to have.
                     *
                     * Rounded down, so a trim never takes a theme below its target.
                     */
                    const take = (trim.excessUsdc * valued.valueUsdc) / trim.valueUsdc;
                    const capped = take < valued.valueUsdc ? take : valued.valueUsdc;
                    units = (held.units * capped) / valued.valueUsdc;
                    if (units > 0n) reason = "rebalance";
                }
            }
        }
        if (reason === null) continue;

        if (units <= 0n) {
            note("the amount to sell works out at nothing");
            continue;
        }
        if (units > held.units) {
            note(`asked to sell ${units} units but ${theme} holds ${held.units}`);
            continue;
        }

        // Value the slice actually being sold, not the whole holding: a partial exit is worth its share.
        const valueUsdc = units === held.units ? valued.valueUsdc : (valued.valueUsdc * units) / held.units;
        if (valueUsdc < i.terms.minTradeUsdc) {
            note(
                `${formatUsdc(valueUsdc)} of ${theme} is below the mandate's minimum trade of ` +
                `${formatUsdc(i.terms.minTradeUsdc)}, so selling would cost more in fees than it returns`,
            );
            continue;
        }

        const costUsdc = costOfUnits({ ...position!, units: held.units, costUsdcIn: held.costUsdcIn }, units);
        candidates.push({
            asset: held.asset,
            symbol,
            theme,
            units,
            valueUsdc,
            costUsdc,
            moveBps: valued.moveBps,
            reason,
            ...(partlyUnrecorded(position!) !== null && { caveat: partlyUnrecorded(position!)! }),
        });
        legs.push({
            asset: held.asset,
            symbol,
            theme,
            usdcIn: valueUsdc,
            maxSlippageBps: i.terms.maxSlippageBps,
            side: "sell",
            unitsIn: units,
        });
    }

    // An asset the owner named that holds nothing at all never reached the loop above, and silence
    // would read as "sold" rather than "there was nothing there".
    for (const [asset, request] of asked) {
        if (open.some((h) => h.asset === asset)) continue;
        skipped.push({
            asset,
            symbol: i.symbols.get(asset) ?? asset,
            why: request.units === undefined
                ? "no position in this token, so there is nothing to sell"
                : `no position in this token, so ${request.units} units cannot be sold`,
        });
    }

    // Biggest exit first, so an owner reading a proposal sees what moves the most money at the top.
    const order = (a: { valueUsdc: bigint }, b: { valueUsdc: bigint }): number =>
        a.valueUsdc < b.valueUsdc ? 1 : a.valueUsdc > b.valueUsdc ? -1 : 0;
    candidates.sort(order);
    legs.sort((a, b) => order({ valueUsdc: a.usdcIn }, { valueUsdc: b.usdcIn }));
    return { legs, candidates, skipped, drift };
}

/** Re-exported so callers naming a themeless holding do not have to spell the sentinel. */
export { NO_THEME, holdingOf };
