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