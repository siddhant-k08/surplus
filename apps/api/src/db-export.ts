import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    serializeTx,
    serializeMandate,
    formatUsdc,
    openLedger,
    realizedSales,
} from "@surplus/core";
import { loadConfig } from "./config";
import { loadRootEnv, fromRepoRoot } from "./paths";
import { openSql, PgBriefBackend, PgLedgerStore, PgMandateBackend, PgReceiptStore } from "./pg";

/**
 * Copies the books out of Postgres into the same JSONL the file backend writes.
 *
 * The mirror of `db:import`, and the reason it exists is not symmetry: a deployment's records should not
 * live only in a place the operator does not control. A provider's backups are theirs, retention on a
 * free plan is short, and a dropped database is a dropped database. This produces a copy that can be
 * read with `cat`, replayed by the file backend, and kept anywhere.
 *
 * Nothing is written to the database. The output is written to a directory given on the command line,
 * defaulting to `data/export-<timestamp>`.
 */

async function main(): Promise<void> {
    loadRootEnv();
    const config = loadConfig();
    if (config.databaseUrl === "") {
        throw new Error("DATABASE_URL is not set; there is no database to export");
    }

    const given = process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = given !== undefined && given !== "" ? fromRepoRoot(given) : fromRepoRoot(`data/export-${stamp}`);

    const sql = openSql(config.databaseUrl, { max: 2 });
    const written: string[] = [];
    const write = (name: string, lines: readonly string[]): void => {
        const path = join(out, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, lines.map((l) => l + "\n").join(""));
        written.push(`${name}: ${lines.length} line(s)`);
    };

    try {
        for (const [name, book] of [
            ["ledger-sales.jsonl", `sales-${config.mode}`],
            ["ledger-invest.jsonl", `invest-${config.investMode}`],
        ] as const) {
            const store = new PgLedgerStore(sql, book);
            const entries = await store.load();
            write(name, entries.map(serializeTx));
            if (entries.length > 0) {
                // read back through the same replay the agent uses, so an export that would not load is
                // caught here rather than on the day it is needed
                const ledger = await openLedger(store);
                const sales = realizedSales(entries);
                written.push(
                    `  ${book}: ${sales.length} settled sale(s), ` +
                    `cash ${formatUsdc(ledger.balance("cash.operating"))} USDC`,
                );
            }
        }

        const mandates = await new PgMandateBackend(sql).load();
        write("mandate.jsonl", mandates.map(serializeMandate));

        // Every receipt, in the order they were issued. Read through the store rather than straight
        // from the table, so each one goes through the same validation a file line would.
        const receipts = new PgReceiptStore(sql);
        const ids = await sql<{ id: string }[]>`select id from receipts order by at asc`;
        const everyReceipt: string[] = [];
        for (const { id } of ids) {
            const found = await receipts.find(id);
            if (found !== null) everyReceipt.push(JSON.stringify(found));
        }
        write("receipts.jsonl", everyReceipt);

        const custom = await new PgBriefBackend(sql, "custom").list();
        for (const saved of custom) {
            const [row] = await sql<{ document: unknown }[]>`
                select document from briefs where id = ${saved.brief.id}
            `;
            const path = join(out, "briefs-custom", saved.file);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify(row?.document ?? {}, null, 2));
        }
        written.push(`briefs-custom/: ${custom.length} brief(s)`);

        console.log(`Exported to ${out}`);
        for (const line of written) console.log(`  ${line}`);
        console.log("\nNothing in the database was changed. Keep this somewhere that is not the database.");
    } finally {
        await sql.end({ timeout: 5 });
    }
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
