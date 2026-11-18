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
    const gap = i.reserveTarget > i.reserveBalance ? i.reserveTarget - i.reserveBalance : 0n;
    const reserveTopUp = available < gap ? available : gap;
    const surplus = available - reserveTopUp;
    const investable = mulBps(surplus, i.investShareBps);
    const retained = surplus - investable;
    return { net, reserveTopUp, surplus, investable, retained, shortfall };
}

/** Book the reserve top-up and the surplus split. Assumes revenue and costs are already booked.*/
export function bookSurplus(
    ledger: Ledger,
    r: SurplusResult,
    opts: { mode: Mode; at: Date; key: string },
): void {
    if (r.reserveTopUp > 0n) {
        ledger.post({
            type: "RESERVE_TOPUP",
            mode: opts.mode,
            at: opts.at,
            idempotencyKey: `${opts.key}:reserve`,
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
            lines,
        });
    }
}