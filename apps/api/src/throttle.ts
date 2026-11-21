import type { NextFunction, Request, Response } from "express";
import type { Sql } from "./pg";

/**
 * A ceiling on how often one caller may use the free routes that do work.
 *
 * Most of this API is protected by either payment or a signature. Four routes are neither: the two
 * nonce routes and the two that spend a nonce. They are cheap to call and not free to serve. The nonce
 * routes in particular write a row each time, so without a ceiling an anonymous caller can grow a table
 * in someone else's database for nothing.
 *
 * Shared rather than per-process, because a host that runs many instances would otherwise multiply the
 * limit by however many it happens to be running. A fixed window is used rather than anything cleverer:
 * one round trip, no coordination, and the worst case is a caller getting twice the allowance across a
 * window boundary, which is the right trade for a limit whose job is to stop abuse rather than to meter
 * billing.
 */

export interface Throttle {
    /** True when this key may proceed. Counts the attempt either way. */
    allow(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** In memory, for one long-running process and for tests. */
export class MemoryThrottle implements Throttle {
    private readonly windows = new Map<string, { startedAt: number; count: number }>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
        const t = this.now();
        const found = this.windows.get(key);
        if (found === undefined || t - found.startedAt >= windowMs) {
            this.windows.set(key, { startedAt: t, count: 1 });
            // old keys would otherwise accumulate for ever in a long-running process
            if (this.windows.size > 10_000) {
                for (const [k, v] of this.windows) if (t - v.startedAt >= windowMs) this.windows.delete(k);
            }
            return 1 <= limit;
        }
        found.count += 1;
        return found.count <= limit;
    }
}

/** Shared across every instance, which is the point. One statement per call. */
export class PgThrottle implements Throttle {
    constructor(private readonly sql: Sql, private readonly now: () => number = () => Date.now()) {}

    async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
        const at = new Date(this.now());
        const windowStart = new Date(this.now() - windowMs);
        const [row] = await this.sql<{ count: number }[]>`
            insert into rate_limits (key, window_start, count)
            values (${key}, ${at}, 1)
            on conflict (key) do update set
                count = case when rate_limits.window_start <= ${windowStart} then 1 else rate_limits.count + 1 end,
                window_start = case when rate_limits.window_start <= ${windowStart} then ${at} else rate_limits.window_start end
            returning count
        `;
        return (row?.count ?? 1) <= limit;
    }
}

/**
 * Who is calling, as well as this can be known behind a proxy.
 *
 * The left-most entry of `x-forwarded-for` is the client as the first proxy saw it. A caller can put
 * anything there, so this is not identity and is not used as such: it only decides whose allowance is
 * spent, and a caller who forges it is spreading their own calls across buckets rather than escaping a
 * limit on anyone else.
 */
export function callerKey(req: Request): string {
    const forwarded = req.header("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    return first !== undefined && first !== "" ? first : (req.socket.remoteAddress ?? "unknown");
}

/** Express middleware applying one named limit. */
export function limit(args: { throttle: Throttle; name: string; max: number; windowMs: number }) {
    return function throttled(req: Request, res: Response, next: NextFunction): void {
        void args.throttle
            .allow(`${args.name}:${callerKey(req)}`, args.max, args.windowMs)
            .then((ok) => {
                if (ok) return next();
                res.setHeader("retry-after", Math.ceil(args.windowMs / 1000).toString());
                res.status(429).json({ error: "too many requests; wait a moment and try again" });
            })
            .catch((e: unknown) => {
                // A limiter that cannot answer must not take the route down with it. Logged, then the
                // request proceeds: the limit exists to stop abuse, not to be a dependency of the API.
                console.error(`rate limit check failed for ${args.name}, allowing the request:`, e);
                next();
            });
    };
}
