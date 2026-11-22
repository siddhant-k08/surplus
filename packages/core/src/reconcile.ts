import { Ledger, type AccountId } from "./ledger";

export interface ReconcileResult {
    ok: boolean;
    issues: string[];
}

const MUST_NOT_BE_NEGATIVE = (a: AccountId): boolean =>
    a === "cash.operating" ||
    a === "reserve" ||
    a === "surplus.investable" ||
    a === "surplus.retained" ||
    a.startsWith("positions.");

/** Internal checks only. For the chain, see `comparePositions`. */
export function reconcileInternal(ledger: Ledger): ReconcileResult {
    const issues: string[] = [];
    const txs = ledger.all();

    let prevAt = "";
    txs.forEach((t, i) => {
        if (t.id !== i + 1) issues.push(`transaction ${i + 1} has id ${t.id}`);
        const sum = t.lines.reduce((a, l) => a + l.amount, 0n);
        if (sum !== 0n) issues.push(`transaction ${t.id} does not sum to zero`);
        if (t.at < prevAt) issues.push(`transaction ${t.id} is out of time order`);
        prevAt = t.at;
    });

    let total = 0n;
    for (const [account, v] of ledger.balances()) {
        total += v;
        if (v < 0n && MUST_NOT_BE_NEGATIVE(account)) issues.push(`negative balance on ${account}`);
    }
    if (total !== 0n) issues.push(`balances sum to ${total}, expected 0`);

    const replayed = Ledger.replay(txs).balances();
    const live = ledger.balances();
    for (const [account, v] of live) {
        if ((replayed.get(account) ?? 0n) !== v) issues.push(`replay mismatch on ${account}`);
    }
    for (const account of replayed.keys()) {
        if (!live.has(account)) issues.push(`replay has extra account ${account}`);
    }

    return { ok: issues.length === 0, issues };
}

/** What the agent believes it bought of one token, and what the wallet actually holds. */
export interface PositionComparison {
    asset: string;
    symbol: string;
    /** Token units the agent's own record of its swaps says it received. */
    bookedUnits: bigint;
    /** Token units the wallet holds right now. */
    heldUnits: bigint;
    /** Held minus booked. Negative is the serious direction. */
    differenceUnits: bigint;
    verdict: "matches" | "short" | "extra";
}

export interface PositionReconciliation {
    ok: boolean;
    positions: PositionComparison[];
    issues: string[];
}

/**
 * Compares what the agent says it bought against what the wallet holds.
 *
 * The internal checks prove the books are consistent with themselves, which is not the same as being
 * true. This is the one that can catch a lie: a swap recorded that never happened, a transfer out
 * nobody booked, a fill attributed twice.
 *
 * Short is the serious direction. The books claiming tokens the wallet does not hold is either a fill
 * that was booked without happening or tokens that left without an entry, and both need a person. Extra
 * is reported but not a failure: a wallet can be funded from outside the agent, and the agent is not the
 * only thing allowed to put tokens in it.
 *
 * Nothing here is derived from a quote or a price. Units bought against units held, both integers.
 */
export function comparePositions(
    booked: readonly { asset: string; symbol: string; units: bigint }[],
    held: ReadonlyMap<string, bigint>,
): PositionReconciliation {
    const positions: PositionComparison[] = [];
    const issues: string[] = [];

    for (const b of booked) {
        const key = b.asset.toLowerCase();
        const heldUnits = held.get(key) ?? 0n;
        const differenceUnits = heldUnits - b.units;
        const verdict = differenceUnits === 0n ? "matches" : differenceUnits > 0n ? "extra" : "short";
        positions.push({ asset: key, symbol: b.symbol, bookedUnits: b.units, heldUnits, differenceUnits, verdict });
        if (verdict === "short") {
            issues.push(
                `${b.symbol}: the books say ${b.units} units were bought but the wallet holds ${heldUnits}, ` +
                `short by ${-differenceUnits}`,
            );
        }
    }

    return { ok: issues.length === 0, positions, issues };
}
