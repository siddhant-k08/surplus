export type Mode = "sim" | "testnet" | "mainnet";

export type AccountId =
    | "equity.opening"
    | "cash.operating"
    | "reserve"
    | "surplus.retained"
    | "surplus.investable"
    | "revenue.research"
    | "expense.llm"
    | "expense.search"
    | "expense.gas"
    | `positions.${string}`;

export type EntryType =
    | "OPENING_BALANCE"
    | "PAYMENT_RECEIVED"
    | "PAYMENT_FAILED"
    | "COST_ACCRUED"
    | "RESERVE_TOPUP"
    | "SURPLUS_ALLOCATED"
    | "PROPOSAL_CREATED"
    | "REFUSAL"
    | "APPROVAL_RECORDED"
    | "PURCHASE_SETTLED"
    | "RECONCILIATION";

export interface Line {
    readonly account: AccountId;
    readonly amount: bigint; // debit positive, credit negative
}

export interface PostInput {
    type: EntryType;
    mode: Mode;
    lines: readonly Line[];
    at?: Date;
    memo?: string;
    txHash?: string;
    idempotencyKey?: string;
    /** What this movement was for. Structured so state can be rebuilt from the ledger, unlike a memo. */
    briefId?: string;
}

export interface LedgerTx {
    readonly id: number;
    readonly at: string; // ISO timestamp, UTC
    readonly type: EntryType;
    readonly mode: Mode;
    readonly lines: readonly Line[];
    readonly memo?: string;
    readonly txHash?: string;
    readonly idempotencyKey?: string;
    readonly briefId?: string;
}

function sameLines(a: readonly Line[], b: readonly Line[]): boolean {
    return (
        a.length === b.length &&
        a.every((l, i) => l.account === b[i]?.account && l.amount === b[i]?.amount)
    );
}

export class Ledger {
    private readonly txs: LedgerTx[] = [];
    private readonly byKey = new Map<string, LedgerTx>();
    private readonly bal = new Map<AccountId, bigint>();

    post(input: PostInput): LedgerTx {
        const lines: Line[] = input.lines.map((l) => ({
            account: l.account,
            amount: l.amount,
        }));

        if (input.idempotencyKey !== undefined) {
            const prior = this.byKey.get(input.idempotencyKey);
            if (prior) {
                if (prior.type !== input.type || !sameLines(prior.lines, lines)) {
                    throw new Error(
                        `Idempotency key ${input.idempotencyKey} reused with different content`,
                    );
                }
                return prior;
            }
        }

        let sum = 0n;
        for (const l of lines) {
            if (l.amount === 0n) throw new Error(`Zero-amount line on ${l.account}`);
            sum += l.amount;
        }
        if (sum !== 0n) throw new Error(`Unbalanced transaction: lines sum to ${sum}`);

        const at = (input.at ?? new Date()).toISOString();
        const last = this.txs[this.txs.length - 1];
        if (last && at < last.at) {
            throw new Error(`Out-of-order timestamp: ${at} is before ${last.at}`);
        }

        const tx: LedgerTx = Object.freeze({
            id: this.txs.length + 1,
            at,
            type: input.type,
            mode: input.mode,
            lines: Object.freeze(lines),
            ...(input.memo !== undefined && { memo: input.memo }),
            ...(input.txHash !== undefined && { txHash: input.txHash }),
            ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
            ...(input.briefId !== undefined && { briefId: input.briefId }),
        });

        this.txs.push(tx);
        if (input.idempotencyKey !== undefined) this.byKey.set(input.idempotencyKey, tx);
        for (const l of lines) {
            this.bal.set(l.account, (this.bal.get(l.account) ?? 0n) + l.amount);
        }
        return tx;
    }

    balance(account: AccountId): bigint {
        return this.bal.get(account) ?? 0n;
    }

    balances(): ReadonlyMap<AccountId, bigint> {
        return new Map(this.bal);
    }

    all(): readonly LedgerTx[] {
        return this.txs;
    }

    /**
     * Rebuilds a ledger from its own entries.
     *
     * Every field has to come back, not just the amounts. Losing `idempotencyKey` would empty the dedup
     * index and let a replayed ledger book the same payment or fill twice; losing `txHash` would cut the
     * link to the onchain transaction.
     */
    static replay(txs: readonly LedgerTx[]): Ledger {
        const ledger = new Ledger();
        for (const t of txs) {
            ledger.post({
                type: t.type,
                mode: t.mode,
                lines: t.lines,
                at: new Date(t.at),
                ...(t.memo !== undefined && { memo: t.memo }),
                ...(t.txHash !== undefined && { txHash: t.txHash }),
                ...(t.idempotencyKey !== undefined && { idempotencyKey: t.idempotencyKey }),
                ...(t.briefId !== undefined && { briefId: t.briefId }),
            });
        }
        return ledger;
    }
}