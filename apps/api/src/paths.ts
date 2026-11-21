import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The root the deployment's own files are read from: the repo `.env`, the owner's catalogue.
 *
 * Derived from this file's location rather than from the working directory, because npm runs a workspace
 * script with the workspace as its cwd. `apps/api` would then be the root when the server starts through
 * `npm run api`, and a relative briefs directory or the root `.env` would silently point inside it,
 * which looked like a missing config value.
 *
 * That derivation assumes this file sits at `apps/api/src/`, which is true of the source and false of
 * the bundled serverless function, where it ends up pointing above the deployment entirely. So
 * `SURPLUS_ROOT` wins when it is set, and is trusted as given: it is the operator (or the serverless
 * entry point, which sets it from the working directory) stating where the files are, and a deployment
 * that ships no `package.json` beside them would otherwise fail the probe below and be overruled.
 * Failing that, the derived path is used only when it really looks like the project, and the working
 * directory is the last resort.
 */
const derived = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const looksLikeRoot = (dir: string): boolean => existsSync(join(dir, "package.json"));
const explicit = process.env.SURPLUS_ROOT?.trim();

export const REPO_ROOT = explicit !== undefined && explicit !== ""
    ? explicit
    : [derived, process.cwd()].find(looksLikeRoot) ?? derived;

/** Loads the repo root `.env` whatever the working directory is. Returns the path when one was read. */
export function loadRootEnv(): string | null {
    const envPath = resolve(REPO_ROOT, ".env");
    if (!existsSync(envPath)) return null;
    process.loadEnvFile(envPath);
    return envPath;
}

/** Resolves a configured directory against the repo root, so relative values mean what they look like. */
export function fromRepoRoot(dir: string): string {
    return isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir);
}
