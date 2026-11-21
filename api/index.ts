import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../apps/api/src/config";
import { loadRootEnv } from "../apps/api/src/paths";
import { assemble, type Assembled } from "../apps/api/src/app";

/**
 * The serverless entry point.
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
    assembling ??= assemble(loadConfig()).catch((e: unknown) => {
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
