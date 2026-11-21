import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBriefs, loadBriefs, loadLatestBrief } from "../src/briefstore";

describe("M3 regression: a corrupt brief file does not take everything down", () => {
    it("skips the bad file, keeps the good ones, and reports the problem", () => {
        const dir = mkdtempSync(join(tmpdir(), "surplus-briefscan-"));
        const good = (id: string, at: string) => JSON.stringify({
            provider: "gemini", model: "m", costUsdcMinor: "21188",
            brief: { id, createdAt: at, sources: [], themes: [], disclaimer: "d" },
        });
        writeFileSync(join(dir, "a.json"), good("b-old", "2026-11-20T00:00:00.000Z"));
        writeFileSync(join(dir, "b.json"), good("b-new", "2026-11-21T00:00:00.000Z"));
        writeFileSync(join(dir, "truncated.json"), '{"provider":"gemini","brief":{');

        const scan = scanBriefs(dir);
        expect(scan.briefs.map((b) => b.brief.id)).toEqual(["b-new", "b-old"]);
        expect(scan.problems.map((p) => p.file)).toEqual(["truncated.json"]);
        expect(loadBriefs(dir).length).toBe(2);
        expect(loadLatestBrief(dir).brief.id).toBe("b-new");
        rmSync(dir, { recursive: true, force: true });
    });

    it("treats a missing directory as empty rather than throwing", () => {
        const scan = scanBriefs(join(tmpdir(), "surplus-does-not-exist-" + Date.now()));
        expect(scan.briefs).toEqual([]);
        expect(scan.problems).toEqual([]);
    });
});
