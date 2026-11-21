import { Ledger, type LedgerTx } from "./ledger";
import type { MandateVersion } from "./mandate";
import { restoreMandateStore, MandateStore } from "./mandate";

/**
 * Where the books live.
 *
 * The agent's guarantees are about behaviour, not about files: append only, idempotent by key,
 * chronological, exact integers, and a hash chain that detects tampering. A port lets those guarantees
 * be met by a directory of JSONL on a disk or by a database, and keeps the domain ignorant of which.
 *
 * Everything is async because a database is. A file-backed implementation simply resolves immediately.
 */

export interface LedgerSource {
    /** Every entry ever written, oldest first. */
    load(): Promise<LedgerTx[]>;
}

export interface LedgerSink {
    /**
     * Appends entries in order.
     *
     * Must be idempotent on entry id: a retry after a partial write has to be safe, because the
     * alternative is a ledger that counts a settlement twice.
     */
    append(txs: readonly LedgerTx[]): Promise<void>;
}

export type LedgerStore = LedgerSource & LedgerSink;

export interface MandateBackend {
    load(): Promise<MandateVersion[]>;
    append(version: MandateVersion): Promise<void>;
}

/**
 * A ledger rebuilt from storage, with its dedup index and balances restored.
 *
 * Replaying is what restores the idempotency keys, and the restored keys are what stop a settlement
 * booking twice after a restart.
 */
export async function openLedger(source: LedgerSource): Promise<Ledger> {
    return Ledger.replay(await source.load());
}

/** The owner's mandate history, with its hash chain verified, or null when nothing is stored. */
export async function openMandateStore(backend: MandateBackend): Promise<MandateStore | null> {
    const versions = await backend.load();
    if (versions.length === 0) return null;
    return restoreMandateStore(versions);
}

/**
 * Appends whatever a ledger holds that storage has not seen, and returns the new high-water mark.
 *
 * Entry ids run from 1 in order, so the id doubles as the cursor and no separate bookkeeping is needed.
 */
export async function flushNewEntries(
    ledger: Ledger,
    sink: LedgerSink,
    lastPersistedId: number,
): Promise<number> {
    const pending = ledger.all().filter((t) => t.id > lastPersistedId);
    if (pending.length === 0) return lastPersistedId;
    await sink.append(pending);
    return pending[pending.length - 1]!.id;
}
