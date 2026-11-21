import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { REPO_ROOT, fromRepoRoot } from "../src/paths";
import { loadConfig } from "../src/config";

describe("paths", () => {
    it("finds the repo root from the module, not the working directory", () => {
        // npm runs this workspace's scripts with apps/api as the cwd, so the cwd is not the root
        const pkg: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
        expect((pkg as { name?: string }).name).toBe("surplus");
    });

    it("resolves a relative directory against the repo root and leaves an absolute one alone", () => {
        expect(fromRepoRoot("docs/briefs")).toBe(resolve(REPO_ROOT, "docs/briefs"));
        expect(fromRepoRoot("/var/data")).toBe("/var/data");
    });

    it("gives the config an absolute briefs directory whatever the cwd is", () => {
        const c = loadConfig({ X402_PAY_TO: "0x" + "a".repeat(40), OWNER_TOKEN: "owner-token-for-tests-only", OWNER_ADDRESS: "0x" + "9".repeat(40) });
        expect(isAbsolute(c.briefsDir)).toBe(true);
        expect(c.briefsDir).toBe(resolve(REPO_ROOT, "docs/briefs"));
    });

    it("says where it looked when a required value is missing", () => {
        expect(() => loadConfig({})).toThrow(new RegExp(`${REPO_ROOT}/\\.env`));
    });
});
