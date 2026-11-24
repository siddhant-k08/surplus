import { formatUsdc } from "./money";
import { validateTerms, type MandateTerms } from "./mandate";
import { costOfUnits, partlyUnrecorded, unsellable, valuePosition, type Position } from "./positions";
import type { Leg } from "./policy";

/**
 * When the agent sells, and why.
 *
 * The mandate states the exit the same way it states the entry, so the agent never decides for itself
 * when to take money off the table. With neither exit term set this returns nothing, which is the
 * correct behaviour for an owner who has not said when to sell: silence is not permission.
 *
 * The owner can also ask for a specific exit, which needs no rule and no price trigger. That path is
 * still bound by everything else: the units must be held, the size must clear the mandate's minimum,
 * and the owner still signs the proposal.
 *
 * Nothing here executes anything. It produces legs, which go through the same proposal, policy check,
 * signature and drift gate every buy goes through.
 */

export type ExitReason = "take_profit" | "stop_loss" | "owner_request";

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
}

export interface ExitInput {
    positions: ReadonlyMap<string, Position>;
    /** USDC minor units per one whole token, from a live quote. */
    prices: ReadonlyMap<string, bigint>;
    decimals: ReadonlyMap<string, number>;
    /** Symbol per lowercase address, for messages a person reads. */
    symbols: ReadonlyMap<string, string>;
    /** The theme a position was bought under, so a sale is attributed where the buy was. */
    themes: ReadonlyMap<string, string>;
    terms: MandateTerms;
    /**
     * Exits the owner asked for by name, overriding the price rules.
     *
     * `units` absent means the whole position. An asset named here is never also evaluated against the
     * rules: the owner asking is the decision, and a second opinion from a threshold would either
     * duplicate the leg or quietly refuse what was asked for.
     */
    requested?: readonly { asset: string; units?: bigint }[];
}

/** Why this position is being sold, or null to hold it. */
function trigger(moveBps: number, t: MandateTerms): ExitReason | null {
    if (t.takeProfitBps !== undefined && moveBps >= t.takeProfitBps) return "take_profit";
    if (t.stopLossBps !== undefined && moveBps <= -t.stopLossBps) return "stop_loss";
    return null;
}

export function exitPlan(i: ExitInput): ExitPlan {
    validateTerms(i.terms);
    const legs: Leg[] = [];
    const candidates: ExitCandidate[] = [];
    const skipped: Skipped[] = [];
    const asked = new Map((i.requested ?? []).map((r) => [r.asset.toLowerCase(), r]));

    for (const [asset, position] of i.positions) {
        const symbol = i.symbols.get(asset) ?? asset;
        const request = asked.get(asset);
        const note = (why: string): void => void skipped.push({ asset, symbol, why });

        const cannot = unsellable(position);
        if (cannot !== null) {
            // Only worth saying for a position that still has money in it. An asset already sold out of
            // holds nothing, which is not news.
            if (position.costUsdcIn > 0n || request !== undefined) note(cannot);
            continue;
        }

        const price = i.prices.get(asset);
        const decimals = i.decimals.get(asset);
        if (price === undefined || decimals === undefined) {
            note("no live quote for this token, so what it is worth now is unknown");
            continue;
        }
        const valued = valuePosition(position, price, decimals);
        if (valued === null) {
            note("this position cannot be valued at the quoted price");
            continue;
        }

        const reason = request !== undefined ? "owner_request" : trigger(valued.moveBps, i.terms);
        if (reason === null) continue;

        const units = request?.units ?? position.units;
        if (units <= 0n) {
            note("the requested amount is not positive");
            continue;
        }
        if (units > position.units) {
            note(`asked to sell ${units} units but only ${position.units} are held`);
            continue;
        }

        // Value the slice actually being sold, not the whole position: a partial exit is worth its share.
        const valueUsdc = units === position.units ? valued.valueUsdc : (valued.valueUsdc * units) / position.units;
        if (valueUsdc < i.terms.minTradeUsdc) {
            note(
                `${formatUsdc(valueUsdc)} is below the mandate's minimum trade of ` +
                `${formatUsdc(i.terms.minTradeUsdc)}, so selling would cost more in fees than it returns`,
            );
            continue;
        }

        candidates.push({
            asset,
            symbol,
            theme: i.themes.get(asset) ?? "unattributed",
            units,
            valueUsdc,
            costUsdc: costOfUnits(position, units),
            moveBps: valued.moveBps,
            reason,
            ...(partlyUnrecorded(position) !== null && { caveat: partlyUnrecorded(position)! }),
        });
        legs.push({
            asset,
            symbol,
            theme: i.themes.get(asset) ?? "unattributed",
            usdcIn: valueUsdc,
            maxSlippageBps: i.terms.maxSlippageBps,
            side: "sell",
            unitsIn: units,
        });
    }

    // An asset the owner named that holds nothing at all never reached the loop above, and silence
    // would read as "sold" rather than "there was nothing there".
    for (const [asset, request] of asked) {
        if (i.positions.has(asset)) continue;
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
    return { legs, candidates, skipped };
}
