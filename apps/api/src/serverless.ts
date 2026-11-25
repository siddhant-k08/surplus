import type { IncomingMessage, ServerResponse } from "node:http";

// Before anything that reads it. The bundle sits at the deployment root rather than at apps/api/src, so
// the path derived from this module's location points above the deployment: on the host, the working
// directory is where the files actually are. Set first because `REPO_ROOT` is computed when `paths` is
// first evaluated, and the owner's catalogue is resolved against it.
process.env.SURPLUS_ROOT ??= process.cwd();

const { loadConfig } = await import("./config");
const { assemble } = await import("./app");
const { loadRootEnv } = await import("./paths");
const { log, errorFields } = await import("./log");
type Assembled = Awaited<ReturnType<typeof assemble>>;

/**
 * The serverless entry point.
 *
 * Bundled to `api/index.mjs` by `npm run build:serverless`, which is what the host actually runs. The
 * host's builder transpiles a TypeScript function without bundling it, which leaves extensionless
 * relative imports that Node cannot resolve and a CommonJS wrapper around ESM syntax; the function then
 * fails to boot on every request. Bundling here also resolves `@surplus/core`, whose entry point is
 * TypeScript source rather than built JavaScript.
 *
 * A serverless host may replace this process between any two requests, so two things matter here that do
 * not matter for the long-running server:
 *
 * - Nothing may be kept in memory that has to survive. The books, the mandate, the receipts and the
 *   sessions all live in Postgres (see `DATABASE_URL`), which is what makes this safe to run at all.
 *   With the JSONL files this would lose settlements, so storage refuses to be an afterthought: the
 *   banner and `GET /health` both say which storage is live.
 * - Assembly happens once per instance, not once per request. Reading the ledger and verifying the
 *   mandate chain on every request would be both slow and pointless.
 *
 * The second of those was wrong on its own, and production proved it. A host runs several instances at
 * once, each with its own cached assembly, and the books live in memory inside it. Writes reached the
 * database and the other instances never saw them: `GET /health` reported seven sales while the database
 * held twelve, and a proposal created and approved on one instance answered "Unknown proposal" when the
 * execute landed on another. Nothing was lost, because every write was idempotent and the ledger refused
 * to double-count, but the loop could not be completed and the public numbers changed between refreshes.
 *
 * So the cache stays and gains a staleness check: one query for the highest entry id in each book and the
 * highest mandate version, and the assembly is rebuilt only when one of them has moved. The storage
 * handle is reused across rebuilds, because opening a connection per rebuild would exhaust the database's
 * connection ceiling, and recovery is not re-run, because it belongs to taking over from a predecessor
 * rather than to noticing that a neighbour has written a row.
 *
 * A failed assembly is not cached. The next request tries again, because the usual cause is a database
 * that was briefly unreachable, and an instance that had given up for good would serve errors until the
 * host happened to recycle it.
 */

loadRootEnv();

let assembling: Promise<Assembled> | null = null;
/** What storage said when the cached assembly was built, so a later request can tell it has moved. */
let readAt = "";

function start(opts: { backends?: Assembled["backends"] } = {}): Promise<Assembled> {
    assembling ??= assemble(loadConfig(), { ...opts, recover: opts.backends === undefined })
        .then(async (ready) => {
            readAt = (await ready.backends.marker?.()) ?? "";
            // One line per cold start, in the host's logs. Storage and the catalogue are the two things
            // that can be wrong on a host while every route still answers, so they are stated rather
            // than assumed: no catalogue means `GET /brief` has nothing to sell.
            const catalogue = await ready.backends.catalogue.list();
            log.info("assembled", "Surplus assembled", {
                storage: ready.backends.kind,
                root: process.env.SURPLUS_ROOT ?? "derived",
                catalogue: ready.config.briefsDir,
                briefs: catalogue.length,
                mandateVersion: ready.mandates.current().version,
                sales: ready.sales.length,
            });
            return ready;
        })
        .catch((e: unknown) => {
            assembling = null;
            throw e;
        });
    return assembling;
}

/**
 * The assembly, rebuilt first when another instance has written since this one read.
 *
 * The marker query is the cost of correctness here: without it this instance answers from a snapshot of
 * the books taken whenever it happened to start, which is both wrong and silently wrong.
 */
async function current(): Promise<Assembled> {
    const ready = await start();
    if (ready.backends.marker === undefined) return ready;

    const now = await ready.backends.marker();
    if (now === readAt) return ready;

    log.info("books_moved", "storage moved since this instance read it; rebuilding", {
        was: readAt,
        now,
    });
    assembling = null;
    // The same storage handle: this rebuild is about what was written, not about reconnecting.
    return start({ backends: ready.backends });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let ready: Assembled;
    try {
        ready = await current();
    } catch (e) {
        // the request is answered rather than dropped, and the reason is logged where the host collects it
        log.error("startup_failed", "could not start Surplus", errorFields(e));
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "this server is not ready; see the deployment logs" }));
        return;
    }
    ready.app(req, res);
}
