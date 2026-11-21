import { Ledger, type LedgerTx } from "./ledger";
import type { MandateTerms, MandateVersion } from "./mandate";
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

/**
 * The owner's mandate history.
 *
 * Sync or async: the file-backed store is synchronous because loading the mandate has to happen before
 * the server will start at all, and a database is not. Callers await either way.
 */
export interface MandateBackend {
    /** Stored versions in order. Empty means no mandate has been set yet. */
    load(): MandateVersion[] | Promise<MandateVersion[]>;
    append(version: MandateVersion): void | Promise<void>;
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
 * The stored mandate, or a first version created from `initial` when storage holds none.
 *
 * A stored mandate is authoritative: the terms in code only ever create version 1. A later deployment
 * shipping different defaults must not quietly reset what the owner set, so `created` says which
 * happened and nothing is written when a mandate already exists.
 */
export async function openMandateFrom(
    backend: MandateBackend,
    initial: MandateTerms,
    at: Date = new Date(),
): Promise<{ mandates: MandateStore; created: boolean }> {
    const existing = await openMandateStore(backend);
    if (existing !== null) return { mandates: existing, created: false };
    const mandates = new MandateStore();
    await backend.append(mandates.create(initial, at));
    return { mandates, created: true };
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
