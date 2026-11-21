import { randomBytes, timingSafeEqual } from "node:crypto";
import { verifyTypedData, getAddress, isAddress } from "viem";
import type { NextFunction, Request, Response } from "express";

/**
 * Owner sign-in by wallet signature.
 *
 * The owner routes used to need `OWNER_TOKEN` in an Authorization header, which meant a browser had to
 * hold a long-lived shared secret. The owner already proves who they are with a wallet when approving a
 * trade, so the same wallet signs them in and the token never reaches a browser at all. The token stays
 * for machine and CLI callers, which have nowhere to keep a cookie.
 *
 * What stops the obvious attacks:
 *
 * - the nonce is single use and short lived, so a captured signature cannot be replayed
 * - the signature is EIP-712 with a chain id in the domain, so it is not valid on another chain
 * - the recovered address must equal the configured `OWNER_ADDRESS`, which never comes from the request
 * - the cookie is httpOnly and SameSite=Strict, so a page on another origin cannot ride it
 */

export const SESSION_COOKIE = "surplus_session";
export const NONCE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 8 * 60 * 60_000;

export const LOGIN_TYPES = {
    Login: [
        { name: "statement", type: "string" },
        { name: "address", type: "address" },
        { name: "nonce", type: "string" },
        { name: "issuedAt", type: "uint256" },
    ],
} as const;

export const LOGIN_STATEMENT = "Sign in to the Surplus owner desk. This authorises reading and proposing, never a trade.";

export interface LoginPayload {
    domain: { name: string; version: string; chainId: number };
    types: typeof LOGIN_TYPES;
    primaryType: "Login";
    message: { statement: string; address: `0x${string}`; nonce: string; issuedAt: bigint };
}

interface Issued {
    expiresAt: number;
    issuedAt: number;
}

/**
 * Where nonces and sessions live.
 *
 * A port, because the right answer depends on how the process runs. One long-lived process can keep them
 * in memory, where a restart signs the owner out and that is the safe direction. A process that can be
 * replaced between two requests cannot: the cookie it handed out a second ago would be unknown to the
 * next instance, and sign-in would never stick. Either way a session is short lived and swept.
 *
 * Async because a database is.
 */
export interface SessionStore {
    /** A fresh single-use nonce for the owner to sign. */
    issueNonce(): Promise<{ nonce: string; issuedAt: number; expiresAt: number }>;
    /** Spends a nonce. Returns when it was issued, or null if it is unknown, used or expired. */
    consumeNonce(nonce: string): Promise<number | null>;
    /** Starts a session for an address and returns the cookie value. */
    open(address: string): Promise<{ token: string; expiresAt: number }>;
    /** The address behind a cookie, or null when it is unknown or expired. */
    whoIs(token: string): Promise<string | null>;
    close(token: string): Promise<void>;
    /** Live sessions. For the startup banner, not for a request's path. */
    count(): Promise<number>;
}

/** A fresh nonce. Shared by every implementation so the entropy is not an implementation detail. */
export const newNonce = (): string => randomBytes(16).toString("hex");
/** A fresh session cookie value. */
export const newSessionToken = (): string => randomBytes(32).toString("hex");

/**
 * Nonces and sessions in memory. The right choice for one long-running process.
 *
 * A restart signs the owner out, which is the safe direction: nothing a browser holds outlives the
 * process that issued it.
 */
export class MemorySessionStore implements SessionStore {
    private readonly nonces = new Map<string, Issued>();
    private readonly sessions = new Map<string, { address: string; expiresAt: number }>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    private sweep(): void {
        const t = this.now();
        for (const [k, v] of this.nonces) if (v.expiresAt <= t) this.nonces.delete(k);
        for (const [k, v] of this.sessions) if (v.expiresAt <= t) this.sessions.delete(k);
    }

    async issueNonce(): Promise<{ nonce: string; issuedAt: number; expiresAt: number }> {
        this.sweep();
        const nonce = newNonce();
        const issuedAt = Math.floor(this.now() / 1000);
        const expiresAt = this.now() + NONCE_TTL_MS;
        this.nonces.set(nonce, { expiresAt, issuedAt });
        return { nonce, issuedAt, expiresAt };
    }

    async consumeNonce(nonce: string): Promise<number | null> {
        this.sweep();
        const found = this.nonces.get(nonce);
        if (found === undefined) return null;
        this.nonces.delete(nonce); // single use, whatever happens next
        return found.issuedAt;
    }

    async open(address: string): Promise<{ token: string; expiresAt: number }> {
        this.sweep();
        const token = newSessionToken();
        const expiresAt = this.now() + SESSION_TTL_MS;
        this.sessions.set(token, { address, expiresAt });
        return { token, expiresAt };
    }

    async whoIs(token: string): Promise<string | null> {
        this.sweep();
        return this.sessions.get(token)?.address ?? null;
    }

    async close(token: string): Promise<void> {
        this.sessions.delete(token);
    }

    async count(): Promise<number> {
        this.sweep();
        return this.sessions.size;
    }
}

/** The exact payload the owner's wallet signs. */
export function loginPayload(args: {
    address: string;
    nonce: string;
    issuedAt: number;
    chainId: number;
}): LoginPayload {
    return {
        domain: { name: "Surplus", version: "1", chainId: args.chainId },
        types: LOGIN_TYPES,
        primaryType: "Login",
        message: {
            statement: LOGIN_STATEMENT,
            address: getAddress(args.address),
            nonce: args.nonce,
            issuedAt: BigInt(args.issuedAt),
        },
    };
}

export type LoginVerdict = { ok: true; address: `0x${string}` } | { ok: false; reason: string };

/** Checks a sign-in signature against the configured owner. */
export async function verifyLogin(args: {
    signature: string;
    nonce: string;
    issuedAt: number;
    chainId: number;
    ownerAddress: string;
}): Promise<LoginVerdict> {
    if (!/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
        return { ok: false, reason: "signature must be 65 bytes of hex" };
    }
    if (!isAddress(args.ownerAddress)) return { ok: false, reason: "the configured owner address is not valid" };
    const owner = getAddress(args.ownerAddress);
    const payload = loginPayload({ address: owner, nonce: args.nonce, issuedAt: args.issuedAt, chainId: args.chainId });

    try {
        const valid = await verifyTypedData({
            address: owner,
            domain: payload.domain,
            types: payload.types,
            primaryType: payload.primaryType,
            message: payload.message,
            signature: args.signature as `0x${string}`,
        });
        // deliberately one message for every failure: the caller learns it failed, not how close it came
        return valid ? { ok: true, address: owner } : { ok: false, reason: "not a valid owner signature" };
    } catch (e) {
        return { ok: false, reason: `signature could not be verified: ${e instanceof Error ? e.message : String(e)}` };
    }
}

/** Reads one cookie without pulling in a parser; values here are hex, so no decoding is needed. */
export function readCookie(header: string | undefined, name: string): string | null {
    if (header === undefined) return null;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        return part.slice(eq + 1).trim();
    }
    return null;
}

const sameSecret = (given: string, expected: string): boolean => {
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Lets a request through when it carries either a valid owner session cookie or the owner token.
 *
 * Two doors on purpose: a browser uses the cookie it got by signing in, and a script uses the token.
 * Neither is the authority to trade; that is still the EIP-712 signature on the approval itself.
 */
export function requireOwnerAccess(args: { token: string; sessions: SessionStore }) {
    if (args.token === "") throw new Error("owner token must not be empty");

    return async function ownerGate(req: Request, res: Response, next: NextFunction): Promise<void> {
        const cookie = readCookie(req.header("cookie"), SESSION_COOKIE);
        if (cookie !== null && (await args.sessions.whoIs(cookie)) !== null) {
            next();
            return;
        }

        const header = req.header("authorization") ?? "";
        const match = /^Bearer (.+)$/.exec(header);
        if (match !== null && sameSecret(match[1]!, args.token)) {
            next();
            return;
        }

        res.status(401).json({ error: "sign in with the owner wallet, or send the owner token" });
    };
}
