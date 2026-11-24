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

describe("the underwater term and stored-mandate compatibility", () => {
    it("leaves the hash of a mandate written before the term existed untouched", () => {
        // The migration hazard: adding a field that the hash covers would make every stored mandate
        // fail verification and the server refuse to start. canonicalJson drops undefined keys, and the
        // parser must not invent a default, so an old mandate hashes exactly as it did.
        const before = new MandateStore().create(baseTerms());
        const roundTripped = parseMandateFile(serializeMandate(before), "f")[0]!;
        expect(roundTripped.hash).toBe(before.hash);
        expect("investOnlyWhenAhead" in roundTripped.terms).toBe(false);
        expect(() => new MandateStore().adopt([roundTripped])).not.toThrow();
    });

    it("carries the term when an owner sets it, and keeps the chain verifiable", () => {
        const live = new MandateStore();
        const v1 = live.create(baseTerms());
        const v2 = live.create(baseTerms({ investOnlyWhenAhead: true }));
        expect(v2.terms.investOnlyWhenAhead).toBe(true);
        expect(v2.hash).not.toBe(v1.hash);

        const back = parseMandateFile(`${serializeMandate(v1)}\n${serializeMandate(v2)}`, "f");
        const store = new MandateStore();
        store.adopt(back);
        expect(store.verifyChain()).toBe(true);
        expect(store.current().terms.investOnlyWhenAhead).toBe(true);
    });

    it("refuses a stored term that is not a boolean", () => {
        const live = new MandateStore();
        const line = serializeMandate(live.create(baseTerms({ investOnlyWhenAhead: true })));
        expect(() => parseMandateFile(line.replace('"investOnlyWhenAhead":true', '"investOnlyWhenAhead":"yes"'), "f"))
            .toThrow(/must be true or false/);
    });
});

describe("every term reaches the file", () => {
    /** A mandate with every optional term set, so nothing can be absent by accident. */
    const everyTerm = () => baseTerms({
        investOnlyWhenAhead: true,
        takeProfitBps: 2500,
        stopLossBps: 1500,
        rebalanceBandBps: 500,
    });

    it("writes and reads back every term the mandate has", () => {
        // The test that would have caught the real bug. serializeMandate once listed the fields it
        // wrote, and the exit terms were not on the list: an owner set rebalanceBandBps, it was hashed
        // into the version, and then dropped on the way to disk. The constraint was live in the running
        // process and absent from the file, and the next boot refused to load the mandate at all.
        //
        // Written over the keys rather than over a list of names, so a term added later is covered here
        // the moment it exists.
        const v = new MandateStore().create(everyTerm());
        const back = parseMandateFile(serializeMandate(v), "f")[0]!;

        for (const key of Object.keys(v.terms) as (keyof typeof v.terms)[]) {
            expect(back.terms[key], `terms.${key} did not survive the file`).toEqual(v.terms[key]);
        }
        expect(Object.keys(back.terms).sort()).toEqual(Object.keys(v.terms).sort());
    });

    it("keeps the hash verifiable, which is what a dropped term breaks", () => {
        const live = new MandateStore();
        const v1 = live.create(baseTerms());
        const v2 = live.create(everyTerm());

        const store = new MandateStore();
        store.adopt(parseMandateFile(`${serializeMandate(v1)}\n${serializeMandate(v2)}`, "f"));
        expect(store.verifyChain()).toBe(true);
        expect(store.current().terms.rebalanceBandBps).toBe(500);
    });

    it("refuses a line whose term was written away, rather than loading a weaker mandate", () => {
        // Exactly what the broken serializer produced: terms that no longer hash to the recorded hash.
        const line = serializeMandate(new MandateStore().create(everyTerm()));
        const stripped = line.replace(',"rebalanceBandBps":500', "");
        expect(stripped).not.toBe(line);
        expect(() => new MandateStore().adopt(parseMandateFile(stripped, "f")))
            .toThrow(/hash does not match its terms/);
    });

    it("refuses a stored term it does not know, naming it", () => {
        // A term added to the mandate but not taught to the parser would otherwise be ignored, loading a
        // mandate missing one of its constraints. Refusing by name says what to fix.
        const line = serializeMandate(new MandateStore().create(baseTerms()));
        const extra = line.replace('"eligible"', '"maxDrawdownBps":900,"eligible"');
        expect(() => parseMandateFile(extra, "f")).toThrow(/unknown stored term maxDrawdownBps/);
    });

    it("refuses an exit term that is not an integer", () => {
        const line = serializeMandate(new MandateStore().create(everyTerm()));
        expect(() => parseMandateFile(line.replace('"takeProfitBps":2500', '"takeProfitBps":25.5'), "f"))
            .toThrow(/takeProfitBps must be an integer/);
    });
});
