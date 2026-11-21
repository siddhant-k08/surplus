import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Builds the deployment the way the host actually wants it: the Build Output API.
 *
 * Why not the simple `functions` config: that one matches globs against the files in the repository,
 * and the serverless function is a bundle produced by this build rather than a file anyone commits.
 * A deploy from this machine worked because the bundle existed locally and was uploaded with the
 * source; a deploy triggered by a git push failed, because in a fresh clone the pattern matched
 * nothing. Two deployment paths with different behaviour is the problem, not the error message.
 *
 * Writing `.vercel/output` directly removes the question: this script produces the static site, the
 * function and the routing table, and both paths run this same script.
 *
 * Layout, which the platform defines:
 *   .vercel/output/config.json                     routing
 *   .vercel/output/static/                         the web app, served as files
 *   .vercel/output/functions/api.func/index.mjs    the bundled server
 *   .vercel/output/functions/api.func/docs/briefs  the owner's catalogue, read at runtime
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
const fn = join(out, "functions", "api.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// 1. the web app, already built by `npm run build:web`
cpSync(join(root, "apps", "web", "dist"), join(out, "static"), { recursive: true });

// 2. the bundled function, built by `npm run build:serverless`
cpSync(join(root, "api", "index.mjs"), join(fn, "index.mjs"));

// 3. the owner's catalogue. Repository content, read from disk at runtime, so it has to travel with
//    the function: without it `GET /brief` has nothing to sell and `/health` reports no brief.
cpSync(join(root, "docs", "briefs"), join(fn, "docs", "briefs"), { recursive: true });

writeFileSync(
    join(fn, ".vc-config.json"),
    JSON.stringify(
        {
            runtime: "nodejs22.x",
            handler: "index.mjs",
            launcherType: "Nodejs",
            shouldAddHelpers: true,
            // generating a brief calls SEC EDGAR and then a model; measured at about 16 seconds
            maxDuration: 60,
            memory: 1024,
        },
        null,
        2,
    ) + "\n",
);

writeFileSync(
    join(out, "config.json"),
    JSON.stringify(
        {
            version: 3,
            routes: [
                // the API, served by the one function. Everything else is the single-page app.
                {
                    src: "^/(?:health|brief|research|ledger|catalogue|mandate|invest|auth|receipt)(?:/.*)?$",
                    dest: "/api",
                },
                // static files win over the fallback, so assets are served as themselves
                { handle: "filesystem" },
                { src: "/.*", dest: "/index.html" },
            ],
        },
        null,
        2,
    ) + "\n",
);

console.log(`built .vercel/output: static site, api.func, ${process.env.npm_lifecycle_event ?? "build"}`);
