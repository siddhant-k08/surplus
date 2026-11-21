import { existsSync, readFileSync } from "node:fs";
import {
    JsonlLedgerStore,
    JsonlMandateStore,
    openLedger,
    formatUsdc,
    realizedSales,
} from "@surplus/core";
import { loadConfig } from "./config";
import { loadRootEnv } from "./paths";
import { migrate, openSql, PgBriefBackend, PgLedgerStore, PgMandateBackend, PgReceiptStore } from "./pg";
import { DirBriefBackend } from "./briefs";
import { JsonlReceiptStore } from "./receipts";
import { parseReceiptLine } from "./receipts";

/**
 * Copies the books out of the JSONL files into Postgres.
 *
 * Needed once, when a deployment moves from a disk to a database: the agent's real sales, their
 * settlement transactions, the owner's mandate history and every buyer's receipt are the things that
 * cannot be recomputed. Starting the database empty would not lose them from the files, but it would
 * mean the deployed agent no longer knows about them.
 *
 * Safe to run more than once. Every write is idempotent on the key that identifies the record, the files
 * are only read, and nothing in Postgres is updated or deleted. Prints a plan and writes nothing unless
 * `--apply` is given.
 */

const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
    loadRootEnv();
    const config = loadConfig();
    if (config.databaseUrl === "") {
        throw new Error("DATABASE_URL is not set; there is no database to import into");
    }

    const sql = openSql(config.databaseUrl, { max: 2 });
    try {
        if (apply) await migrate(sql);

        const report: string[] = [];

        // ---- the two ledger books ----
        for (const [label, path, book] of [
            ["sales", config.ledgerPath, `sales-${config.mode}`],
            ["invest", config.investLedgerPath, `invest-${config.investMode}`],
        ] as const) {
            const file = new JsonlLedgerStore(path);
            const entries = await file.load();
            if (entries.length === 0) {
                report.push(`${label}: nothing in ${path}`);
                continue;
            }
            const sales = realizedSales(entries);
            const ledger = await openLedger(file);
            const cash = formatUsdc(ledger.balance("cash.operating"));
            report.push(
                `${label}: ${entries.length} entries, ${sales.length} settled sale(s), cash ${cash} USDC ` +
                `-> book "${book}"`,
            );
            if (!apply) continue;

            const target = new PgLedgerStore(sql, book);
            await target.append(entries);
            const back = await target.load();
            if (back.length !== entries.length) {
                throw new Error(`${label}: wrote ${entries.length} entries but read back ${back.length}`);
            }
            // the stored entries must be the same entries, not merely the same count
            for (const [i, e] of entries.entries()) {
                const got = back[i]!;
                if (got.id !== e.id || got.txHash !== e.txHash || got.idempotencyKey !== e.idempotencyKey) {
                    throw new Error(`${label}: entry ${e.id} did not come back intact`);
                }
            }
            report.push(`${label}: verified ${back.length} entries in the database`);
        }

        // ---- the mandate history ----
        const mandateFile = new JsonlMandateStore(config.mandatePath);
        const versions = mandateFile.load();
        if (versions.length === 0) {
            report.push(`mandate: nothing in ${config.mandatePath}`);
        } else {
            const current = versions[versions.length - 1]!;
            report.push(`mandate: ${versions.length} version(s), current v${current.version} ${current.hash.slice(0, 12)}`);
            if (apply) {
                const target = new PgMandateBackend(sql);
                for (const v of versions) await target.append(v);
                const back = await target.load();
                report.push(`mandate: verified ${back.length} version(s), current v${back[back.length - 1]!.version}`);
            }
        }

        // ---- receipts ----
        if (!existsSync(config.receiptsPath)) {
            report.push(`receipts: nothing at ${config.receiptsPath}`);
        } else {
            const lines = readFileSync(config.receiptsPath, "utf8").split("\n").filter((l) => l.trim() !== "");
            report.push(`receipts: ${lines.length} issued`);
            if (apply) {
                const target = new PgReceiptStore(sql);
                for (const [i, line] of lines.entries()) {
                    await target.issue(parseReceiptLine(line, `${config.receiptsPath} line ${i + 1}`));
                }
                report.push(`receipts: verified ${await target.count()} in the database`);
            }
            // read through the file store as well, so a malformed line is reported the same way
            new JsonlReceiptStore(config.receiptsPath);
        }

        // ---- buyer-commissioned briefs ----
        const customDir = new DirBriefBackend(config.customBriefsDir);
        const custom = await customDir.list();
        const problems = await customDir.problems();
        report.push(`custom briefs: ${custom.length} readable, ${problems.length} unreadable in ${config.customBriefsDir}`);
        for (const p of problems) report.push(`custom briefs: cannot read ${p.file}: ${p.error}`);
        if (apply && custom.length > 0) {
            const target = new PgBriefBackend(sql, "custom");
            for (const saved of custom) {
                const document: unknown = JSON.parse(
                    readFileSync(`${config.customBriefsDir}/${saved.file}`, "utf8"),
                );
                await target.save(saved, document as Parameters<typeof target.save>[1]);
            }
            report.push(`custom briefs: verified ${(await target.list()).length} in the database`);
        }

        console.log(apply ? "Imported into Postgres:" : "Would import into Postgres (nothing written):");
        for (const line of report) console.log(`  ${line}`);
        if (!apply) {
            console.log("\nRun it again with --apply to write. The JSONL files are never modified.");
        } else {
            console.log("\nThe files are untouched. Keep them: they are the backup of what was imported.");
        }
    } finally {
        await sql.end({ timeout: 5 });
    }
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
