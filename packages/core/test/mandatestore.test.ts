import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MandateStore } from "../src/mandate";
import { JsonlMandateStore, openMandate, parseMandateFile, serializeMandate } from "../src/mandatestore";
import { parseUsdc as u } from "../src/money";
import { baseTerms } from "./fixtures";

const dirs: string[] = [];
function freshPath(): string {
    const d = mkdtempSync(join(tmpdir(), "surplus-mandate-"));
    dirs.push(d);
    return join(d, "nested", "mandate.jsonl");
}
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("mandate persistence", () => {
    it("round-trips a version with its hash, chain and limits intact", () => {
        const path = freshPath();
        const store = new JsonlMandateStore(path);
        const live = new MandateStore();
        const v1 = live.create(baseTerms());
        store.append(v1);

        const back = store.loadStore()!;
        expect(back.current()).toEqual(v1);
        expect(back.current().terms.maxTradeUsdc).toBe(u("1.00"));
        expect(back.verifyChain()).toBe(true);
    });

    it("stores limits as strings so a constraint never passes through a float", () => {
        const live = new MandateStore();
        const line = serializeMandate(live.create(baseTerms()));
        expect(JSON.parse(line).terms.maxTradeUsdc).toBe("1000000");
        expect(line).not.toContain("1e+");
    });

    it("keeps a multi-version chain in order", () => {
        const path = freshPath();
        const store = new JsonlMandateStore(path);
        const live = new MandateStore();
        store.append(live.create(baseTerms()));
        store.append(live.create(baseTerms({ maxSlippageBps: 50 })));

        const back = store.loadStore()!;
        expect(back.history().length).toBe(2);
        expect(back.current().version).toBe(2);
        expect(back.current().prevHash).toBe(back.get(1)!.hash);
        expect(back.current().terms.maxSlippageBps).toBe(50);
    });

    it("refuses a stored mandate whose terms were altered", () => {
        const path = freshPath();
        const store = new JsonlMandateStore(path);
        const live = new MandateStore();
        store.append(live.create(baseTerms()));

        // loosen a limit on disk while leaving the hash alone, which is what an attacker would do
        const tampered = readFileSync(path, "utf8").replace('"maxTradeUsdc":"1000000"', '"maxTradeUsdc":"999000000"');
        writeFileSync(path, tampered);
        expect(() => store.loadStore()).toThrow(/was altered/);
    });

    it("refuses a history with a version removed", () => {
        const path = freshPath();
        const store = new JsonlMandateStore(path);
        const live = new MandateStore();
        store.append(live.create(baseTerms()));
        store.append(live.create(baseTerms({ maxSlippageBps: 50 })));

        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        writeFileSync(path, lines[1] + "\n"); // keep only version 2
        expect(() => store.loadStore()).toThrow(/not contiguous|does not chain/);
    });

    it("refuses a history that does not chain", () => {
        const live = new MandateStore();
        const v1 = live.create(baseTerms());
        const v2 = live.create(baseTerms({ maxSlippageBps: 50 }));
        const broken = `${serializeMandate(v1)}\n${serializeMandate({ ...v2, prevHash: "0".repeat(64) })}\n`;
        expect(() => new MandateStore().adopt(parseMandateFile(broken, "f"))).toThrow(/does not chain/);
    });

    it("rejects a float limit, changing nothing else about a valid line", () => {
        const live = new MandateStore();
        const good = serializeMandate(live.create(baseTerms()));
        const floated = good.replace('"maxTradeUsdc":"1000000"', '"maxTradeUsdc":1.5');
        expect(() => parseMandateFile(floated, "f")).toThrow(/maxTradeUsdc must be a decimal string of USDC minor units/);
        expect(() => parseMandateFile(good, "f")).not.toThrow();
    });

    it("rejects a truncated line rather than dropping it", () => {
        expect(() => parseMandateFile("{not json", "f")).toThrow(/truncated|valid JSON/);
    });
});

describe("openMandate", () => {
    it("creates the first version when nothing is stored", () => {
        const store = new JsonlMandateStore(freshPath());
        const { mandates, created } = openMandate(store, baseTerms());
        expect(created).toBe(true);
        expect(mandates.current().version).toBe(1);
        expect(store.load().length).toBe(1);
    });

    it("treats the stored mandate as authoritative, never resetting it to the code's terms", () => {
        const path = freshPath();
        const store = new JsonlMandateStore(path);
        const first = openMandate(store, baseTerms({ maxSlippageBps: 50 }));
        expect(first.mandates.current().terms.maxSlippageBps).toBe(50);

        // a later deployment ships different defaults; the owner's stored terms must win
        const second = openMandate(store, baseTerms({ maxSlippageBps: 999 }));
        expect(second.created).toBe(false);
        expect(second.mandates.current().terms.maxSlippageBps).toBe(50);
        expect(second.mandates.current().version).toBe(1);
        expect(store.load().length).toBe(1);
    });
});
