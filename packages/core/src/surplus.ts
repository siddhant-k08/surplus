import { mulBps } from "./money";
import type { Ledger, Line, Mode } from "./ledger";

export interface SurplusInput {
    revenue: bigint;
    costs: bigint;
    reserveBalance: bigint;
    reserveTarget: bigint;
    investShareBps: number;
}

export interface SurplusResult {
    net: bigint;
    reserveTopUp: bigint;
    surplus: bigint;
    investable: bigint;
    retained: bigint;
    shortfall: bigint;
}

export interface SweepInput {
    /** Net money available to sweep now. Never negative. */
    available: bigint;
    reserveBalance: bigint;
    reserveTarget: bigint;
    investShareBps: number;
}

export interface SweepResult {
    reserveTopUp: bigint;
    surplus: bigint;
    investable: bigint;
    retained: bigint;
}

/**
 * Splits available money: the reserve gap first, then the invest share of what is left.
 *
 * Separate from `computeSurplus` because settlement happens more than once per brief. A brief can earn
 * again after it was first settled, and the second sweep has to work from what is newly available rather
 * than from the brief's lifetime totals.
 */
export function sweepAvailable(i: SweepInput): SweepResult {
    if (i.available < 0n) throw new Error("available must not be negative");
    if (i.reserveBalance < 0n) throw new Error("reserveBalance must not be negative");
    if (i.reserveTarget < 0n) throw new Error("reserveTarget must not be negative");
    const gap = i.reserveTarget > i.reserveBalance ? i.reserveTarget - i.reserveBalance : 0n;
    const reserveTopUp = i.available < gap ? i.available : gap;
    const surplus = i.available - reserveTopUp;
    const investable = mulBps(surplus, i.investShareBps);
    return { reserveTopUp, surplus, investable, retained: surplus - investable };
}

export function computeSurplus(i: SurplusInput): SurplusResult {
    for (const [name, v] of Object.entries({
        revenue: i.revenue,
        costs: i.costs,
        reserveBalance: i.reserveBalance,
        reserveTarget: i.reserveTarget,
    })) {
        if (v < 0n) throw new Error(`${name} must not be negative`);
    }
    const net = i.revenue - i.costs;
    const shortfall = net < 0n ? -net : 0n;
    const available = net > 0n ? net : 0n;
    const swept = sweepAvailable({
        available,
        reserveBalance: i.reserveBalance,
        reserveTarget: i.reserveTarget,
        investShareBps: i.investShareBps,
    });
    return { net, shortfall, ...swept };
}

export interface InvestmentGapInput {
    /** Lifetime revenue the books prove. */
    revenue: bigint;
    /** Lifetime costs booked. */
    costs: bigint;
    reserveBalance: bigint;
    reserveTarget: bigint;
    investShareBps: number;
    /** The smallest trade the mandate allows. Investable money below this cannot be placed. */
    minTrade: bigint;
    /** Money already sitting as investable. */
    investable: bigint;
}

export interface InvestmentGap {
    /** True when a trade could be proposed right now. */
    canInvest: boolean;
    /** Costs not yet covered by revenue. Nothing reaches the reserve until this is zero. */
    shortfall: bigint;
    /** What the protected reserve still needs before any surplus exists. */
    reserveGap: bigint;
    /** Surplus still needed on top of that, so the invest share clears the minimum trade. */
    surplusNeeded: bigint;
    /** Revenue that would have to arrive before the agent could place its smallest allowed trade. */
    revenueNeeded: bigint;
}

/**
 * How much more the agent must earn before it could invest anything, and what is in the way.
 *
 * The agent refusing to invest is the design working, but "nothing to invest" on its own tells an owner
 * nothing about whether that is one sale away or a hundred. This turns the same rules settlement uses
 * into the number: cover the costs, fill the reserve, then earn enough surplus that the invest share
 * clears the smallest trade the mandate allows.
 *
 * It describes the state as it stands. Selling another brief also costs something to produce, so the
 * real figure moves; this is the floor, not a forecast.
 */
export function investmentGap(i: InvestmentGapInput): InvestmentGap {
    if (i.investShareBps <= 0) {
        // the owner has told the agent to invest none of the surplus; no amount of revenue changes that
        return {
            canInvest: false,
            shortfall: i.costs > i.revenue ? i.costs - i.revenue : 0n,
            reserveGap: i.reserveTarget > i.reserveBalance ? i.reserveTarget - i.reserveBalance : 0n,
            surplusNeeded: 0n,
            revenueNeeded: 0n,
        };
    }
    if (i.investable >= i.minTrade) {
        return { canInvest: true, shortfall: 0n, reserveGap: 0n, surplusNeeded: 0n, revenueNeeded: 0n };
    }

    const shortfall = i.costs > i.revenue ? i.costs - i.revenue : 0n;
    const reserveGap = i.reserveTarget > i.reserveBalance ? i.reserveTarget - i.reserveBalance : 0n;

    // How much surplus the invest share has to be taken from for the result to reach the minimum trade.
    // Rounded up, because the share rounds down: asking for exactly the quotient can land a unit short.
    const missing = i.minTrade - i.investable;
    const bps = BigInt(i.investShareBps);
    const surplusNeeded = (missing * 10_000n + bps - 1n) / bps;

    return {
        canInvest: false,
        shortfall,
        reserveGap,
        surplusNeeded,
        revenueNeeded: shortfall + reserveGap + surplusNeeded,
    };
}

/** Book the reserve top-up and the surplus split. Assumes revenue and costs are already booked.*/
export function bookSurplus(
    ledger: Ledger,
    r: SurplusResult,
    opts: { mode: Mode; at: Date; key: string; briefId?: string },
): void {
    if (r.reserveTopUp > 0n) {
        ledger.post({
            type: "RESERVE_TOPUP",
            mode: opts.mode,
            at: opts.at,
            idempotencyKey: `${opts.key}:reserve`,
            ...(opts.briefId !== undefined && { briefId: opts.briefId }),
            lines: [
                { account: "reserve", amount: r.reserveTopUp },
                { account: "cash.operating", amount: -r.reserveTopUp },
            ],
        });
    }
    if (r.surplus > 0n) {
        const lines: Line[] = [{ account : "cash.operating", amount: -r.surplus }];
        if (r.investable > 0n) lines.push({ account: "surplus.investable", amount: r.investable });
        if (r.retained > 0n) lines.push({ account: "surplus.retained", amount: r.retained });
        ledger.post({
            type: "SURPLUS_ALLOCATED",
            mode: opts.mode,
            at: opts.at,
            idempotencyKey: `${opts.key}:alloc`,
            ...(opts.briefId !== undefined && { briefId: opts.briefId }),
            lines,
        });
    }
}