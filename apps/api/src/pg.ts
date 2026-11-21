import postgres from "postgres";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import {
    serializeTx,
    parseTxLine,
    serializeMandate,
    parseMandateLine,
    type LedgerStore,
    type LedgerTx,
    type MandateBackend,
    type MandateVersion,
    type SavedBrief,
} from "@surplus/core";
import type { Receipt, ReceiptStore } from "./receipts";
import { parseReceiptLine } from "./receipts";
import { savedFromDocument, type BriefBackend, type BriefDocument } from "./briefs";
import {
    NONCE_TTL_MS, SESSION_TTL_MS, newNonce, newSessionToken, type SessionStore,
} from "./session";

/**
 * Postgres behind the same storage ports the JSONL files implement.
 *
 * Why this exists: the agent's books are written while it runs, and some hosts replace the process (and
 * its filesystem) between two requests. A ledger that resets loses settlements that really happened, and
 * a mandate that resets would silently put the owner's constraints back to whatever the code shipped.
 *
 * What is deliberately kept from the file implementation:
 *
 * - Money is stored as the exact line the JSONL file would hold, parsed by the same parser. One
 *   serializer and one validator for both backends, so a row cannot mean something a line would not.
 * - Amounts stay decimal strings of USDC minor units. No numeric, no float, nothing that rounds money.
 * - Appends are idempotent on the key that identifies the entry, so a retry after a failed write cannot
 *   book a settlement twice.
 * - Nothing is ever updated or deleted in the ledger or the mandate history. They are append-only here
 *   too, which is what makes them auditable.
 */

export type Sql = postgres.Sql;

/**
 * Gives each address a fair chance to answer before Node moves on to the next one.
 *
 * Node tries the resolved addresses in parallel and allows each 250 ms, which is fine next to the
 * database and wrong from far away: a round trip to another continent takes longer than that, so every
 * attempt "times out" and the whole connection fails with `ETIMEDOUT` even though a plain socket would
 * have connected. It shows up as a database that is unreachable from a developer's machine while the
 * deployment, which sits beside it, is fine. Widened rather than set, so a deliberately larger value
 * configured elsewhere in the process is left alone.
 */
export function widenConnectWindow(ms = 1500): void {
    if (getDefaultAutoSelectFamilyAttemptTimeout() < ms) setDefaultAutoSelectFamilyAttemptTimeout(ms);
}

/** Opens a connection pool. `max` is small on purpose: this is one process, not a web farm. */
export function openSql(url: string, opts: { max?: number } = {}): Sql {
    widenConnectWindow();
    return postgres(url, {
        max: opts.max ?? 5,
        // a stored money row must never be guessed at, so types are read back as text and parsed here
        transform: { undefined: null },
        onnotice: () => {},
    });
}

/**
 * Creates the tables if they are absent.
 *
 * Plain `create table if not exists`, run at startup, rather than a migration tool: there is one schema
 * and one deployment, and a failed migration on the books is a worse problem than a missing feature.
 * Every column that holds money is text.
 */
export async function migrate(sql: Sql): Promise<void> {
    await sql`
        create table if not exists ledger_entries (
            book              text    not null,
            id                integer not null,
            at                timestamptz not null,
            mode              text    not null,
            type              text    not null,
            tx_hash           text,
            idempotency_key   text,
            brief_id          text,
            line              text    not null,
            primary key (book, id)
        )
    `;
    await sql`
        create table if not exists mandate_versions (
            version    integer primary key,
            hash       text not null,
            prev_hash  text,
            created_at timestamptz not null,
            line       text not null
        )
    `;
    await sql`
        create table if not exists receipts (
            id                 text primary key,
            brief_id           text not null,
            source             text not null,
            transaction        text not null,
            amount_usdc_minor  text not null,
            at                 timestamptz not null,
            payer              text
        )
    `;
    await sql`create index if not exists receipts_transaction_idx on receipts (lower(transaction))`;
    // added after the table existed, so an already-deployed database gets it too
    await sql`alter table receipts add column if not exists payer text`;
    await sql`create index if not exists receipts_payer_idx on receipts (lower(payer))`;
    await sql`
        create table if not exists briefs (
            id                text primary key,
            collection        text not null,
            file              text not null,
            created_at        timestamptz not null,
            cost_usdc_minor   text not null default '0',
            document          jsonb not null
        )
    `;
    // Added after the table existed, so an already-deployed database gets it too. Its own column rather
    // than a field read out of the document, because it is summed on the path of every paid request.
    await sql`alter table briefs add column if not exists cost_usdc_minor text not null default '0'`;
    await sql`create index if not exists briefs_collection_idx on briefs (collection, created_at desc)`;
    await sql`
        create table if not exists sessions (
            token      text primary key,
            address    text not null,
            expires_at timestamptz not null
        )
    `;
    await sql`
        create table if not exists executions (
            key              text primary key,
            status           text not null,
            symbol           text not null,
            asset            text not null,
            usdc_in_minor    text not null,
            tx_hash          text,
            raw_tx           text,
            amount_out_minor text,
            gas_used         text,
            detail           text,
            at               timestamptz not null
        )
    `;
    await sql`
        create table if not exists research_reservations (
            id                text primary key,
            amount_usdc_minor text not null,
            at                timestamptz not null
        )
    `;
    await sql`
        create table if not exists rate_limits (
            key          text primary key,
            window_start timestamptz not null,
            count        integer not null
        )
    `;
    await sql`
        create table if not exists login_nonces (
            nonce      text primary key,
            issued_at  bigint not null,
            expires_at timestamptz not null
        )
    `;
}

/**
 * One book of the ledger, as rows.
 *
 * `book` separates the sales book from the investing book, the way one file per mode does. They must not
 * mix: the sales book is real money and the investing book is simulated while fills are simulated.
 */
export class PgLedgerStore implements LedgerStore {
    constructor(private readonly sql: Sql, readonly book: string) {
        if (book.trim() === "") throw new Error("a ledger book needs a name");
    }

    async load(): Promise<LedgerTx[]> {
        const rows = await this.sql<{ id: number; line: string }[]>`
            select id, line from ledger_entries where book = ${this.book} order by id asc
        `;
        const out: LedgerTx[] = [];
        for (const row of rows) {
            const tx = parseTxLine(row.line, `${this.book} entry ${row.id}`);
            const prev = out[out.length - 1];
            // same rule as the file: ids run from 1 in order, so a book that starts at 2 lost its first
            // entry, and replay would otherwise carry on from whatever it found
            if (prev === undefined && tx.id !== 1) {
                throw new Error(
                    `${this.book}: the first entry has id ${tx.id}, not 1; the book is missing its beginning`,
                );
            }
            if (prev !== undefined && tx.id !== prev.id + 1) {
                throw new Error(
                    `${this.book}: entry ids jump from ${prev.id} to ${tx.id}; the book is not intact`,
                );
            }
            out.push(tx);
        }
        return out;
    }

    /**
     * Appends entries, skipping any already stored.
     *
     * `do nothing` on the primary key is what makes a retry after a failed write safe. An entry id is
     * assigned in order from 1 and never reused, so a row that is already there is the same entry.
     */
    async append(txs: readonly LedgerTx[]): Promise<void> {
        if (txs.length === 0) return;
        const rows = txs.map((t) => ({
            book: this.book,
            id: t.id,
            at: new Date(t.at),
            mode: t.mode,
            type: t.type,
            tx_hash: t.txHash ?? null,
            idempotency_key: t.idempotencyKey ?? null,
            brief_id: t.briefId ?? null,
            line: serializeTx(t),
        }));
        await this.sql`
            insert into ledger_entries ${this.sql(rows)}
            on conflict (book, id) do nothing
        `;
    }
}

/** The mandate history, as rows. Append-only and hash chained, exactly as the file is. */
export class PgMandateBackend implements MandateBackend {
    constructor(private readonly sql: Sql) {}

    async load(): Promise<MandateVersion[]> {
        const rows = await this.sql<{ version: number; line: string }[]>`
            select version, line from mandate_versions order by version asc
        `;
        return rows.map((r) => parseMandateLine(r.line, `mandate version ${r.version}`));
    }

    /**
     * Stores one version.
     *
     * A row already there with the same hash is the same version arriving twice, which a retry can cause,
     * so it is accepted silently. A different hash at the same version is two writers disagreeing about
     * the owner's constraints, and that is refused loudly rather than resolved by guesswork.
     */
    async append(v: MandateVersion): Promise<void> {
        const inserted = await this.sql<{ version: number }[]>`
            insert into mandate_versions ${this.sql([{
                version: v.version,
                hash: v.hash,
                prev_hash: v.prevHash ?? null,
                created_at: new Date(v.createdAt),
                line: serializeMandate(v),
            }])}
            on conflict (version) do nothing
            returning version
        `;
        if (inserted.length > 0) return;
        const [existing] = await this.sql<{ hash: string }[]>`
            select hash from mandate_versions where version = ${v.version}
        `;
        if (existing?.hash !== v.hash) {
            throw new Error(
                `mandate version ${v.version} is already stored with a different hash; ` +
                `refusing to write a second version ${v.version}`,
            );
        }
    }
}

/** Receipts, as rows. Keyed on the secret issued at purchase, never on the settlement transaction. */
export class PgReceiptStore implements ReceiptStore {
    constructor(private readonly sql: Sql) {}

    async issue(receipt: Receipt): Promise<void> {
        await this.sql`
            insert into receipts ${this.sql([{
                id: receipt.id,
                brief_id: receipt.briefId,
                source: receipt.source,
                transaction: receipt.transaction,
                amount_usdc_minor: receipt.amountUsdcMinor,
                at: new Date(receipt.at),
                payer: receipt.payer ?? null,
            }])}
            on conflict (id) do nothing
        `;
    }

    async find(id: string): Promise<Receipt | null> {
        const rows = await this.sql<Row[]>`select * from receipts where id = ${id}`;
        return rows[0] === undefined ? null : fromRow(rows[0]);
    }

    async forTransaction(transaction: string): Promise<Receipt | null> {
        const rows = await this.sql<Row[]>`
            select * from receipts where lower(transaction) = ${transaction.toLowerCase()} limit 1
        `;
        return rows[0] === undefined ? null : fromRow(rows[0]);
    }

    async forPayer(address: string): Promise<Receipt[]> {
        const rows = await this.sql<Row[]>`
            select * from receipts where lower(payer) = ${address.toLowerCase()} order by at desc
        `;
        return rows.map(fromRow);
    }

    async count(): Promise<number> {
        const [row] = await this.sql<{ n: string }[]>`select count(*)::text as n from receipts`;
        return Number(row?.n ?? 0);
    }
}

interface Row {
    id: string;
    brief_id: string;
    source: string;
    transaction: string;
    amount_usdc_minor: string;
    at: Date;
    payer: string | null;
}

/** Reads a receipt row through the same validator the file lines go through. */
const fromRow = (r: Row): Receipt =>
    parseReceiptLine(
        JSON.stringify({
            id: r.id,
            briefId: r.brief_id,
            source: r.source,
            transaction: r.transaction,
            amountUsdcMinor: r.amount_usdc_minor,
            at: r.at.toISOString(),
            ...(r.payer !== null && { payer: r.payer }),
        }),
        `receipt ${r.id}`,
    );

/**
 * One collection of briefs, as rows.
 *
 * `collection` keeps the owner's catalogue and buyer-commissioned work apart, which the directories do
 * today. Merging them would let the cheap route serve a premium custom brief.
 */
export class PgBriefBackend implements BriefBackend {
    constructor(private readonly sql: Sql, readonly collection: "catalogue" | "custom") {}

    private async rows(): Promise<{ file: string; document: unknown }[]> {
        return this.sql<{ file: string; document: unknown }[]>`
            select file, document from briefs
            where collection = ${this.collection}
            order by created_at desc
        `;
    }

    async list(): Promise<SavedBrief[]> {
        const out: SavedBrief[] = [];
        for (const row of await this.rows()) {
            // an unreadable brief is reported by problems(), never thrown here: one bad document used to
            // take down the paid route, the research cache and the investing loop at once
            try {
                out.push(savedFromDocument(row.file, row.document));
            } catch {
                continue;
            }
        }
        return out;
    }

    async problems(): Promise<{ file: string; error: string }[]> {
        const out: { file: string; error: string }[] = [];
        for (const row of await this.rows()) {
            try {
                savedFromDocument(row.file, row.document);
            } catch (e) {
                out.push({ file: row.file, error: e instanceof Error ? e.message : String(e) });
            }
        }
        return out;
    }

    async save(saved: SavedBrief, document: BriefDocument): Promise<void> {
        await this.sql`
            insert into briefs ${this.sql([{
                id: saved.brief.id,
                collection: this.collection,
                file: saved.file,
                created_at: new Date(saved.brief.createdAt),
                cost_usdc_minor: saved.costUsdcMinor.toString(),
                document: this.sql.json(document as postgres.JSONValue),
            }])}
            on conflict (id) do nothing
        `;
    }

    /**
     * What this collection has cost, summed in the database.
     *
     * `numeric` rather than a float, and returned as a decimal string of minor units, so the total goes
     * through the same exact-integer path every other amount does.
     */
    async totalCostUsdcMinor(): Promise<bigint> {
        const [row] = await this.sql<{ total: string }[]>`
            select coalesce(sum(cost_usdc_minor::numeric), 0)::text as total
            from briefs where collection = ${this.collection}
        `;
        return BigInt(row?.total ?? "0");
    }
}

/**
 * Sessions and sign-in nonces, as rows.
 *
 * Needed when the process that issued a cookie may not be the one that sees it again, which is the case
 * on any host that can replace the process between two requests: in-memory sessions would mean sign-in
 * never sticks. Both tables are swept of expired rows on every write, so neither grows without bound,
 * and a session is still short lived.
 */
export class PgSessionStore implements SessionStore {
    constructor(private readonly sql: Sql, private readonly now: () => number = () => Date.now()) {}

    private async sweep(): Promise<void> {
        const t = new Date(this.now());
        await this.sql`delete from login_nonces where expires_at <= ${t}`;
        await this.sql`delete from sessions where expires_at <= ${t}`;
    }

    async issueNonce(): Promise<{ nonce: string; issuedAt: number; expiresAt: number }> {
        await this.sweep();
        const nonce = newNonce();
        const issuedAt = Math.floor(this.now() / 1000);
        const expiresAt = this.now() + NONCE_TTL_MS;
        await this.sql`
            insert into login_nonces ${this.sql([{
                nonce, issued_at: issuedAt, expires_at: new Date(expiresAt),
            }])}
        `;
        return { nonce, issuedAt, expiresAt };
    }

    /**
     * Spends a nonce.
     *
     * The delete is the claim: `returning` reports what this statement actually removed, so two requests
     * racing on the same nonce cannot both be told it was theirs. That is what makes it single use.
     */
    async consumeNonce(nonce: string): Promise<number | null> {
        const rows = await this.sql<{ issued_at: string }[]>`
            delete from login_nonces
            where nonce = ${nonce} and expires_at > ${new Date(this.now())}
            returning issued_at
        `;
        return rows[0] === undefined ? null : Number(rows[0].issued_at);
    }

    async open(address: string): Promise<{ token: string; expiresAt: number }> {
        await this.sweep();
        const token = newSessionToken();
        const expiresAt = this.now() + SESSION_TTL_MS;
        await this.sql`
            insert into sessions ${this.sql([{ token, address, expires_at: new Date(expiresAt) }])}
        `;
        return { token, expiresAt };
    }

    async whoIs(token: string): Promise<string | null> {
        const rows = await this.sql<{ address: string }[]>`
            select address from sessions
            where token = ${token} and expires_at > ${new Date(this.now())}
        `;
        return rows[0]?.address ?? null;
    }

    async close(token: string): Promise<void> {
        await this.sql`delete from sessions where token = ${token}`;
    }

    async count(): Promise<number> {
        const [row] = await this.sql<{ n: string }[]>`
            select count(*)::text as n from sessions where expires_at > ${new Date(this.now())}
        `;
        return Number(row?.n ?? 0);
    }
}
