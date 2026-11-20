import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

/**
 * The repo root, derived from this file's own location rather than from the working directory.
 *
 * npm runs a workspace script with the workspace as its cwd, so `apps/api` is the cwd when the server
 * starts through `npm run api`. Anything resolved against the cwd (the root `.env`, a relative briefs
 * directory) would silently point at `apps/api` instead, which looked like a missing config value.
 */
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

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
