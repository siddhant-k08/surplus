import { createHash } from "node:crypto";

export interface ThemeTarget {
    readonly id: string;
    readonly targetBps: number;
}

export interface MandateTerms {
    readonly eligible: readonly string[];
    readonly themes: readonly ThemeTarget[];
    readonly maxCompanyBps: number;
    readonly investShareBps: number;
    readonly maxTradeUsdc: bigint;
    readonly minTradeUsdc: bigint;
    readonly reserveTargetUsdc: bigint;
    readonly maxSlippageBps: number;
    readonly driftToleranceBps: number;
    readonly approvalExpirySeconds: number;
    /**
     * Refuse to invest while the agent has spent more over its life than it has earned.
     *
     * Per-brief settlement means one brief that sold well can produce investable surplus even when the
     * business as a whole is behind. Without this the agent would compound a loss.
     *
     * Optional on purpose. `canonicalJson` drops undefined keys, so a mandate written before this term
     * existed hashes exactly as it did before and its stored chain still verifies. A mandate only gains
     * the constraint when an owner sets it.
     */
    readonly investOnlyWhenAhead?: boolean;
}

export interface MandateVersion {
    readonly version: number;
    readonly hash: string;
    readonly prevHash: string | null;
    readonly createdAt: string;
    readonly terms: MandateTerms;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

function checkBps(name: string, v: number, min = 0): void {
    if (!Number.isInteger(v) || v < min || v > 10_000) {
        throw new Error(`${name} must be an integer from ${min} to 10000, got ${v}`);
    }
}

export function normalizeTerms(t: MandateTerms): MandateTerms {
    return {
        ...t,
        eligible: [...new Set(t.eligible.map((a) => a.toLowerCase()))].sort(),
    };
}

export function validateTerms(t: MandateTerms): void {
    if (t.eligible.length === 0) throw new Error("eligible list must not be empty");
    for (const a of t.eligible) {
        if (!ADDRESS.test(a.toLocaleLowerCase())) throw new Error(`Invalid token address: ${a}`);
    }
    if (t.themes.length === 0) throw new Error("at least one theme is required");
    const ids = new Set<string>();
    let total = 0;
    for (const th of t.themes) {
        if (th.id.trim() === "") throw new Error("theme id must not be empty");
        if (ids.has(th.id)) throw new Error(`Duplicate theme id: ${th.id}`);
        ids.add(th.id);
        checkBps(`theme "${th.id}" tartgetBps`, th.targetBps, 1);
        total += th.targetBps;
    }
    if (total > 10_000) throw new Error(`Theme targets sum to ${total} bps, max is 10000`);
    checkBps("maxCompanyBps", t.maxCompanyBps, 1);
    checkBps("investShareBps", t.investShareBps);
    checkBps("maxSlippageBps", t.maxSlippageBps);
    checkBps("driftToleranceBps", t.driftToleranceBps);
    if (t.minTradeUsdc <= 0n) throw new Error("minTradeUsdc must be positive");
    if (t.maxTradeUsdc < t.minTradeUsdc) throw new Error("maxTradeUsdc must be >= minTradeUsdc");
    if (t.reserveTargetUsdc < 0n) throw new Error("reserveTargetUsdc must not be negative");
    if (!Number.isInteger(t.approvalExpirySeconds) || t.approvalExpirySeconds <= 0) {
        throw new Error("approvalExpirySeconds must be a positive integer");
    }
}

/** Deterministic JSON: sorted keys, bigint as a tagged string. */
export function canonicalJson(value: unknown): string {
    if (typeof value === "bigint") return JSON.stringify(`${value}n`);
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashMandate(
    version: number,
    prevHash: string | null,
    terms: MandateTerms,
): string {
    return createHash("sha256")
        .update(canonicalJson({ version, prevHash, terms }))
        .digest("hex");
}

/** Name of the fields that differ between two sets of terms */
export function diffTerms(a: MandateTerms, b: MandateTerms): string[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MandateTerms>;
    return [...keys].filter((k) => canonicalJson(a[k]) !== canonicalJson(b[k])).sort();
}

export class MandateStore {
    private readonly versions: MandateVersion[] = [];

    /** Only the Owner path may call this (signature check arrives with the wallet milestone). */
    create(terms: MandateTerms, at: Date = new Date()): MandateVersion {
        const normalized = normalizeTerms(terms);
        validateTerms(normalized);
        const prev = this.versions[this.versions.length - 1];
        const version = (prev?.version ?? 0) + 1;
        const prevHash = prev?.hash ?? null;
        const mv: MandateVersion = Object.freeze({
            version,
            hash: hashMandate(version, prevHash, normalized),
            prevHash,
            createdAt: at.toISOString(),
            terms: Object.freeze(normalized),
        });
        this.versions.push(mv);
        return mv;
    }

    current(): MandateVersion {
        const c = this.versions[this.versions.length - 1];
        if (!c) throw new Error("No mandate has been created yet");
        return c;
    }

    get(version: number): MandateVersion | undefined {
        return this.versions[version - 1];
    }

    history(): readonly MandateVersion[] {
        return this.versions;
    }

    /**
     * Takes stored versions as this store's history after checking them.
     *
     * Terms are re-validated and the hash chain recomputed, so a tampered or truncated file is refused.
     * This never creates a version: only the owner path does that.
     */
    adopt(versions: readonly MandateVersion[]): void {
        if (this.versions.length > 0) throw new Error("this store already holds versions");
        let prevHash: string | null = null;
        versions.forEach((v, i) => {
            const expectedVersion = i + 1;
            if (v.version !== expectedVersion) {
                throw new Error(`mandate history is not contiguous: expected version ${expectedVersion}, got ${v.version}`);
            }
            if (v.prevHash !== prevHash) {
                throw new Error(`mandate version ${v.version} does not chain to the previous one`);
            }
            const normalized = normalizeTerms(v.terms);
            validateTerms(normalized);
            const recomputed = hashMandate(v.version, v.prevHash, normalized);
            if (recomputed !== v.hash) {
                throw new Error(`mandate version ${v.version} hash does not match its terms; the stored mandate was altered`);
            }
            prevHash = v.hash;
            this.versions.push(Object.freeze({ ...v, terms: Object.freeze(normalized) }));
        });
    }

    verifyChain(): boolean {
        let prevHash: string | null = null;
        for (const v of this.versions) {
            if (v.prevHash !== prevHash) return false;
            if (v.hash !== hashMandate(v.version, v.prevHash, v.terms)) return false;
            prevHash = v.hash;
        }
        return true;
    }
}

/**
 * Rebuilds a store from stored versions, refusing a chain that does not verify.
 *
 * The mandate is the user's constraint set, so a stored file is exactly what an attacker would edit to
 * loosen a limit. Every version's hash covers its own terms, its version number and the previous hash, so
 * recomputing the chain detects both an altered term and a removed or reordered version. A store that does
 * not verify is refused rather than used: better to stop than to trade under constraints nobody set.
 */
export function restoreMandateStore(versions: readonly MandateVersion[]): MandateStore {
    const store = new MandateStore();
    store.adopt(versions);
    return store;
}
