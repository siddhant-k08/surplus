import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Gate for the owner's own routes: proposing, approving and executing.
 *
 * This is a bearer token, which proves only that the caller holds a secret. It is NOT the owner
 * authorization the design calls for; the EIP-712 wallet signature on approvals replaces it. Until then
 * treat this as "keep the endpoint off the open internet", not as "the owner approved this trade".
 *
 * The comparison is constant time, so a wrong token cannot be narrowed down by timing.
 */
export function requireOwner(token: string) {
    if (token === "") throw new Error("owner token must not be empty");
    const expected = Buffer.from(token, "utf8");

    return function ownerGate(req: Request, res: Response, next: NextFunction): void {
        const header = req.header("authorization") ?? "";
        const match = /^Bearer (.+)$/.exec(header);
        if (match === null) {
            res.status(401).json({ error: "owner token required in an Authorization: Bearer header" });
            return;
        }
        const given = Buffer.from(match[1]!, "utf8");
        // timingSafeEqual throws on a length mismatch, so compare lengths first and keep the same reply
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            res.status(401).json({ error: "owner token is not valid" });
            return;
        }
        next();
    };
}
