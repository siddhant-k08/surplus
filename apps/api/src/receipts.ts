import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What a buyer keeps after paying.
 *
 * The obvious key is the settlement transaction, but that is the wrong choice: settlements are public on
 * Base, so anyone watching the seller's address could harvest hashes and read briefs they never bought.
 * The key is therefore a secret issued at purchase time and returned only in the paid response. The
 * transaction is stored alongside it as proof the buyer can check, never as the way in.
 *
 * Append-only JSONL, like the ledger, so a receipt survives a restart and nothing is ever rewritten.
 */

export interface Receipt {
    /** The secret in the buyer's link. Not derivable from anything public. */
    id: string;
    /** Which brief they bought. */
    briefId: string;
    /** Where that brief lives, so the catalogue and custom directories stay distinct. */
    source: "catalogue" | "custom";
    /** The settlement that paid for it, shown as proof. */
    transaction: string;
    amountUsdcMinor: string;
    at: string;
    /**
     * The address that paid, when the facilitator reported one.
     *
     * Only ever used to give a buyer their own purchases back. The receipt id travels once, in the paid
     * response, and a response that is lost leaves someone charged with no way to what they bought; the
     * paying wallet is the one thing they can still prove. It is never a way in on its own: an address
     * is public, so recovery takes a signature from it.
     */
    payer?: string | undefined;
    /**
     * The CAIP-2 network the settlement happened on, when it was recorded.
     *
     * A transaction hash means nothing without the chain it is on: the same hash shown against the wrong
     * explorer is worse than no link at all. Absent on every receipt written before this field existed,
     * and those must not be guessed at from the running configuration, which can have changed since.
     */
    network?: string | undefined;
}

/**
 * Where receipts live.
 *
 * A port, not a class, because the same guarantees (issue once per settlement, find only by the secret)
 * have to hold whether the rows are lines in a file or in a database. Async because a database is.
 */
export interface ReceiptStore {
    /** Stores a receipt. Must be idempotent on the receipt id, so a replayed settlement writes one row. */
    issue(receipt: Receipt): Promise<void>;
    /** The receipt with this secret, or null. The only way in. */
    find(id: string): Promise<Receipt | null>;
    /** A receipt already written for a settlement, so one payment never issues two. */
    forTransaction(transaction: string): Promise<Receipt | null>;
    /** Every receipt a given address paid for, newest first. Guarded by a signature at the route. */
    forPayer(address: string): Promise<Receipt[]>;
    /** How many have been issued. For the startup banner, not for the buyer's path. */
    count(): Promise<number>;
}

export function newReceiptId(): string {
    return randomBytes(24).toString("base64url");
}

export function parseReceiptLine(line: string, where: string): Receipt {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        throw new Error(`${where}: not valid JSON`);
    }
    if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not an object`);
    const r = raw as Record<string, unknown>;
    const str = (k: string): string => {
        const v = r[k];
        if (typeof v !== "string" || v === "") throw new Error(`${where}: ${k} is missing`);
        return v;
    };
    const source = r.source === "custom" ? "custom" : "catalogue";
    return {
        id: str("id"),
        briefId: str("briefId"),
        source,
        transaction: str("transaction"),
        amountUsdcMinor: str("amountUsdcMinor"),
        at: str("at"),
        // absent on receipts written before the payer was recorded, and on a settlement that reported none
        ...(typeof r.payer === "string" && r.payer !== "" && { payer: r.payer }),
        // absent on every receipt written before the network was recorded; never defaulted
        ...(typeof r.network === "string" && r.network !== "" && { network: r.network }),
    };
}

export class JsonlReceiptStore implements ReceiptStore {
    /** Read once and kept, because a receipt lookup is on the buyer's path and must not stat the disk. */
    private cache: Map<string, Receipt> | null = null;

    constructor(readonly path: string) {}

    private load(): Map<string, Receipt> {
        if (this.cache !== null) return this.cache;
        const map = new Map<string, Receipt>();
        if (existsSync(this.path)) {
            readFileSync(this.path, "utf8")
                .split("\n")
                .forEach((line, i) => {
                    if (line.trim() === "") return;
                    const receipt = parseReceiptLine(line, `${this.path} line ${i + 1}`);
                    map.set(receipt.id, receipt);
                });
        }
        this.cache = map;
        return map;
    }

    async issue(receipt: Receipt): Promise<void> {
        const map = this.load();
        if (map.has(receipt.id)) return; // a replayed settlement must not write a second line
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, JSON.stringify(receipt) + "\n");
        map.set(receipt.id, receipt);
    }

    async find(id: string): Promise<Receipt | null> {
        return this.load().get(id) ?? null;
    }

    async forTransaction(transaction: string): Promise<Receipt | null> {
        for (const r of this.load().values()) {
            if (r.transaction.toLowerCase() === transaction.toLowerCase()) return r;
        }
        return null;
    }

    async forPayer(address: string): Promise<Receipt[]> {
        const wanted = address.toLowerCase();
        return [...this.load().values()]
            .filter((r) => r.payer !== undefined && r.payer.toLowerCase() === wanted)
            .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    }

    async count(): Promise<number> {
        return this.load().size;
    }
}
