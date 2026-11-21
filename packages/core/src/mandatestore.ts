import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    MandateStore,
    restoreMandateStore,
    type MandateTerms,
    type MandateVersion,
    type ThemeTarget,
} from "./mandate";

/**
 * Append-only JSONL persistence for mandate versions.
 *
 * A mandate history is append-only and hash chained, which is the same shape as the ledger, so it gets the
 * same treatment: one version per line, never rewritten, amounts as decimal strings of USDC minor units so
 * a limit cannot be rounded by a float. Loading verifies the chain, because this file is precisely what
 * would be edited to loosen a constraint.
 */

interface StoredTerms {
    eligible: string[];
    themes: ThemeTarget[];
    maxCompanyBps: number;
    investShareBps: number;
    maxTradeUsdc: string;
    minTradeUsdc: string;
    reserveTargetUsdc: string;
    maxSlippageBps: number;
    driftToleranceBps: number;
    approvalExpirySeconds: number;
    investOnlyWhenAhead?: boolean;
}

export function serializeMandate(v: MandateVersion): string {
    const t = v.terms;
    const stored: StoredTerms = {
        eligible: [...t.eligible],
        themes: t.themes.map((x) => ({ id: x.id, targetBps: x.targetBps })),
        maxCompanyBps: t.maxCompanyBps,
        investShareBps: t.investShareBps,
        maxTradeUsdc: t.maxTradeUsdc.toString(),
        minTradeUsdc: t.minTradeUsdc.toString(),
        reserveTargetUsdc: t.reserveTargetUsdc.toString(),
        maxSlippageBps: t.maxSlippageBps,
        driftToleranceBps: t.driftToleranceBps,
        approvalExpirySeconds: t.approvalExpirySeconds,
        // written only when set, so a mandate from before this term keeps its original hash
        ...(t.investOnlyWhenAhead !== undefined && { investOnlyWhenAhead: t.investOnlyWhenAhead }),
    };
    return JSON.stringify({
        version: v.version,
        hash: v.hash,
        prevHash: v.prevHash,
        createdAt: v.createdAt,
        terms: stored,
    });
}

const minor = (v: unknown, field: string, where: string): bigint => {
    if (typeof v !== "string" || !/^\d+$/.test(v)) {
        throw new Error(`${where}: terms.${field} must be a decimal string of USDC minor units, got ${JSON.stringify(v)}`);
    }
    return BigInt(v);
};

const bool = (v: unknown, field: string, where: string): boolean => {
    if (typeof v !== "boolean") throw new Error(`${where}: terms.${field} must be true or false`);
    return v;
};

const int = (v: unknown, field: string, where: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${where}: terms.${field} must be an integer`);
    return v;
};

export function parseMandateLine(line: string, where: string): MandateVersion {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        throw new Error(`${where}: not valid JSON. The mandate file may be truncated by an interrupted write.`);
    }
    if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not an object`);
    const r = raw as Record<string, unknown>;

    if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) {
        throw new Error(`${where}: bad version`);
    }
    if (typeof r.hash !== "string" || !/^[0-9a-f]{64}$/.test(r.hash)) throw new Error(`${where}: bad hash`);
    if (r.prevHash !== null && (typeof r.prevHash !== "string" || !/^[0-9a-f]{64}$/.test(r.prevHash))) {
        throw new Error(`${where}: bad prevHash`);
    }
    if (typeof r.createdAt !== "string" || Number.isNaN(Date.parse(r.createdAt))) {
        throw new Error(`${where}: bad createdAt`);
    }
    if (typeof r.terms !== "object" || r.terms === null) throw new Error(`${where}: missing terms`);
    const t = r.terms as Record<string, unknown>;

    if (!Array.isArray(t.eligible)) throw new Error(`${where}: terms.eligible must be an array`);
    if (!Array.isArray(t.themes)) throw new Error(`${where}: terms.themes must be an array`);

    const terms: MandateTerms = {
        eligible: t.eligible.map((a: unknown, i: number) => {
            if (typeof a !== "string") throw new Error(`${where}: terms.eligible[${i}] must be a string`);
            return a;
        }),
        themes: t.themes.map((x: unknown, i: number) => {
            if (typeof x !== "object" || x === null) throw new Error(`${where}: terms.themes[${i}] must be an object`);
            const o = x as Record<string, unknown>;
            if (typeof o.id !== "string") throw new Error(`${where}: terms.themes[${i}].id must be a string`);
            return { id: o.id, targetBps: int(o.targetBps, `themes[${i}].targetBps`, where) };
        }),
        maxCompanyBps: int(t.maxCompanyBps, "maxCompanyBps", where),
        investShareBps: int(t.investShareBps, "investShareBps", where),
        maxTradeUsdc: minor(t.maxTradeUsdc, "maxTradeUsdc", where),
        minTradeUsdc: minor(t.minTradeUsdc, "minTradeUsdc", where),
        reserveTargetUsdc: minor(t.reserveTargetUsdc, "reserveTargetUsdc", where),
        maxSlippageBps: int(t.maxSlippageBps, "maxSlippageBps", where),
        driftToleranceBps: int(t.driftToleranceBps, "driftToleranceBps", where),
        approvalExpirySeconds: int(t.approvalExpirySeconds, "approvalExpirySeconds", where),
        ...(t.investOnlyWhenAhead === undefined
            ? {}
            : { investOnlyWhenAhead: bool(t.investOnlyWhenAhead, "investOnlyWhenAhead", where) }),
    };

    return { version: r.version, hash: r.hash, prevHash: r.prevHash, createdAt: r.createdAt, terms };
}

export function parseMandateFile(text: string, where = "mandate"): MandateVersion[] {
    const out: MandateVersion[] = [];
    text.split("\n").forEach((line, i) => {
        if (line.trim() === "") return;
        out.push(parseMandateLine(line, `${where} line ${i + 1}`));
    });
    return out;
}

export class JsonlMandateStore {
    constructor(readonly path: string) {}

    /** Stored versions in order. An absent file means no mandate has been set yet. */
    load(): MandateVersion[] {
        if (!existsSync(this.path)) return [];
        return parseMandateFile(readFileSync(this.path, "utf8"), this.path);
    }

    /**
     * The owner's mandate history as a store, with the hash chain verified.
     *
     * Returns null when nothing is stored, so the caller decides what a first run means rather than having
     * a default mandate invented for it.
     */
    loadStore(): MandateStore | null {
        const versions = this.load();
        if (versions.length === 0) return null;
        return restoreMandateStore(versions);
    }

    append(v: MandateVersion): void {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, serializeMandate(v) + "\n");
    }
}

/**
 * Loads the owner's mandate, creating the first version from `initial` only when nothing is stored.
 *
 * Once a mandate exists on disk it is authoritative: the terms in the code are a starting point, never an
 * override. Otherwise a deployment could silently reset the user's constraints back to the defaults, which
 * is exactly what "the agent never changes user constraints" forbids.
 */
export function openMandate(
    store: JsonlMandateStore,
    initial: MandateTerms,
    at: Date = new Date(),
): { mandates: MandateStore; created: boolean } {
    const existing = store.loadStore();
    if (existing !== null) return { mandates: existing, created: false };
    const mandates = new MandateStore();
    store.append(mandates.create(initial, at));
    return { mandates, created: true };
}
