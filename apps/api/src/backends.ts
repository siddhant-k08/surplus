import {
    JsonlLedgerStore,
    JsonlMandateStore,
    type LedgerStore,
    type MandateBackend,
} from "@surplus/core";
import type { ApiConfig } from "./config";
import { DirBriefBackend, type BriefBackend } from "./briefs";
import { JsonlReceiptStore, type ReceiptStore } from "./receipts";
import { MemorySessionStore, type SessionStore } from "./session";
import {
    migrate, openSql,
    PgBriefBackend, PgLedgerStore, PgMandateBackend, PgReceiptStore, PgSessionStore,
    type Sql,
} from "./pg";

/**
 * Everything the server writes to while it runs, in one place.
 *
 * Two deployments, one set of guarantees. Files are right for a machine with a disk: the ledger is its
 * own audit trail and a restart changes nothing. A database is required wherever the process can be
 * replaced between two requests, because then a file written by one instance is not there for the next,
 * which would lose settlements that really happened and put the owner's mandate back to whatever the
 * code shipped without saying so.
 *
 * The catalogue is the exception and stays on the filesystem in both: it is repository content, shipped
 * with the deployment and read-only at runtime. Nothing the server does writes to it.
 */
export interface Backends {
    /** Named in the startup banner, so it is never a guess which storage is live. */
    kind: "files" | "postgres";
    sales: LedgerStore;
    invest: LedgerStore;
    mandate: MandateBackend;
    receipts: ReceiptStore;
    /** The owner's catalogue. Read-only at runtime. */
    catalogue: BriefBackend;
    /** Buyer-commissioned briefs, written while the agent runs. */
    custom: BriefBackend;
    sessions: SessionStore;
    /** Where each kind of record lives, for the banner. */
    lines: string[];
    close: () => Promise<void>;
}

/** The JSONL files on a local disk. */
export function fileBackends(config: ApiConfig): Backends {
    return {
        kind: "files",
        sales: new JsonlLedgerStore(config.ledgerPath),
        invest: new JsonlLedgerStore(config.investLedgerPath),
        mandate: new JsonlMandateStore(config.mandatePath),
        receipts: new JsonlReceiptStore(config.receiptsPath),
        catalogue: new DirBriefBackend(config.briefsDir),
        custom: new DirBriefBackend(config.customBriefsDir),
        sessions: new MemorySessionStore(),
        lines: [
            `                mandate   ${config.mandatePath}`,
            `                receipts  ${config.receiptsPath}`,
            `                custom    ${config.customBriefsDir} (buyer-commissioned, never served to another buyer)`,
            `                sessions  in memory (a restart signs the owner out)`,
        ],
        close: async () => {},
    };
}

/**
 * The same records as rows in Postgres.
 *
 * The book names are the file names' equivalent: one book per mode, so a testnet book and a mainnet book
 * can never share rows, and the simulated investing book stays out of the real one.
 */
export function pgBackends(config: ApiConfig, sql: Sql): Backends {
    const salesBook = `sales-${config.mode}`;
    const investBook = `invest-${config.investMode}`;
    return {
        kind: "postgres",
        sales: new PgLedgerStore(sql, salesBook),
        invest: new PgLedgerStore(sql, investBook),
        mandate: new PgMandateBackend(sql),
        receipts: new PgReceiptStore(sql),
        catalogue: new DirBriefBackend(config.briefsDir),
        custom: new PgBriefBackend(sql, "custom"),
        sessions: new PgSessionStore(sql),
        lines: [
            `                mandate   table mandate_versions`,
            `                receipts  table receipts`,
            `                custom    table briefs, collection "custom"`,
            `                sessions  tables sessions and login_nonces`,
        ],
        close: async () => {
            await sql.end({ timeout: 5 });
        },
    };
}

/**
 * Opens whichever storage this deployment is configured for.
 *
 * `DATABASE_URL` is the whole switch. The schema is created on start when it is absent, which is safe to
 * repeat: every statement is `create ... if not exists`, and nothing in it drops or rewrites a row.
 */
export async function openBackends(config: ApiConfig): Promise<Backends> {
    if (config.databaseUrl === "") return fileBackends(config);
    // One connection per serverless instance: such an instance serves one request at a time, and a
    // provider's connection pooler is the wrong place to be holding five idle sockets per instance.
    const sql = openSql(config.databaseUrl, { max: process.env.VERCEL === undefined ? 5 : 1 });
    try {
        await migrate(sql);
    } catch (e) {
        await sql.end({ timeout: 5 });
        throw new Error(
            `could not prepare the database named by DATABASE_URL: ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    return pgBackends(config, sql);
}

/** How the two ledger books are named in the banner, whichever storage is live. */
export function bookNames(config: ApiConfig, backends: Backends): { sales: string; invest: string } {
    return backends.kind === "files"
        ? { sales: config.ledgerPath, invest: config.investLedgerPath }
        : { sales: `postgres ledger_entries book "sales-${config.mode}"`, invest: `postgres ledger_entries book "invest-${config.investMode}"` };
}
