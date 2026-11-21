import type { IncomingMessage, ServerResponse } from "node:http";

// Before anything that reads it. The bundle sits at the deployment root rather than at apps/api/src, so
// the path derived from this module's location points above the deployment: on the host, the working
// directory is where the files actually are. Set first because `REPO_ROOT` is computed when `paths` is
// first evaluated, and the owner's catalogue is resolved against it.
process.env.SURPLUS_ROOT ??= process.cwd();

const { loadConfig } = await import("./config");
const { assemble } = await import("./app");
const { loadRootEnv } = await import("./paths");
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
 * A failed assembly is not cached. The next request tries again, because the usual cause is a database
 * that was briefly unreachable, and an instance that had given up for good would serve errors until the
 * host happened to recycle it.
 */

loadRootEnv();

let assembling: Promise<Assembled> | null = null;

function start(): Promise<Assembled> {
    assembling ??= assemble(loadConfig())
        .then(async (ready) => {
            // One line per cold start, in the host's logs. Storage and the catalogue are the two things
            // that can be wrong on a host while every route still answers, so they are stated rather
            // than assumed: no catalogue means `GET /brief` has nothing to sell.
            const catalogue = await ready.backends.catalogue.list();
            console.log(
                `Surplus assembled: storage ${ready.backends.kind}, root ${process.env.SURPLUS_ROOT ?? "derived"}, ` +
                `catalogue ${ready.config.briefsDir} (${catalogue.length} brief(s)), ` +
                `mandate v${ready.mandates.current().version}, ${ready.sales.length} sale(s) booked`,
            );
            return ready;
        })
        .catch((e: unknown) => {
            assembling = null;
            throw e;
        });
    return assembling;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let ready: Assembled;
    try {
        ready = await start();
    } catch (e) {
        // the request is answered rather than dropped, and the reason is logged where the host collects it
        console.error("could not start Surplus:", e);
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "this server is not ready; see the deployment logs" }));
        return;
    }
    ready.app(req, res);
}
