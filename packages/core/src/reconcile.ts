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

/** Internal checks only. Comparing against onchain balances comes with the blockchain milestone. */
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