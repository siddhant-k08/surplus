import { parseUsdc, type MandateTerms, type ThemeTarget } from "@surplus/core";

/**
 * Builds new mandate terms from an owner's partial update, starting from the current ones.
 *
 * Only the owner reaches this, and only fields they actually sent are changed: everything else carries
 * over, so a request that mentions one limit cannot silently reset the rest. Amounts are accepted as plain
 * decimal strings like "1.50" and converted with `parseUsdc`, never through a float.
 *
 * Validation of the result is left to `MandateStore.create`, which runs `validateTerms`. This function only
 * has to get the shapes and units right.
 */
export function parseTermsUpdate(
    body: unknown,
    current: MandateTerms,
): { ok: true; terms: MandateTerms } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (typeof body !== "object" || body === null) return { ok: false, errors: ["a JSON object of terms is required"] };
    const b = body as Record<string, unknown>;

    const known = new Set([
        "eligible", "themes", "maxCompanyBps", "investShareBps", "maxSlippageBps",
        "driftToleranceBps", "approvalExpirySeconds", "maxTradeUsdc", "minTradeUsdc", "reserveTargetUsdc",
        "investOnlyWhenAhead", "takeProfitBps", "stopLossBps",
    ]);
    for (const key of Object.keys(b)) {
        // a typo in a limit name would otherwise be accepted and silently change nothing
        if (!known.has(key)) errors.push(`unknown field ${key}`);
    }

    const intField = (name: keyof MandateTerms & string, fallback: number): number => {
        const v = b[name];
        if (v === undefined) return fallback;
        if (typeof v !== "number" || !Number.isInteger(v)) {
            errors.push(`${name} must be an integer`);
            return fallback;
        }
        return v;
    };

    const amountField = (name: string, fallback: bigint): bigint => {
        const v = b[name];
        if (v === undefined) return fallback;
        if (typeof v !== "string" || !/^\d+(\.\d{1,6})?$/.test(v)) {
            errors.push(`${name} must be a decimal amount string like "1.50", with at most 6 decimals`);
            return fallback;
        }
        return parseUsdc(v);
    };

    let eligible: readonly string[] = current.eligible;
    if (b.eligible !== undefined) {
        if (!Array.isArray(b.eligible)) {
            errors.push("eligible must be an array of token addresses");
        } else {
            const bad = b.eligible.filter((a: unknown) => typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a));
            if (bad.length > 0) errors.push("eligible must hold 20 byte hex token addresses");
            else eligible = b.eligible as string[];
        }
    }

    let themes: readonly ThemeTarget[] = current.themes;
    if (b.themes !== undefined) {
        if (!Array.isArray(b.themes)) {
            errors.push("themes must be an array");
        } else {
            const parsed: ThemeTarget[] = [];
            b.themes.forEach((t: unknown, i: number) => {
                if (typeof t !== "object" || t === null) return void errors.push(`themes[${i}] must be an object`);
                const o = t as Record<string, unknown>;
                if (typeof o.id !== "string" || o.id.trim() === "") return void errors.push(`themes[${i}].id is required`);
                if (typeof o.targetBps !== "number" || !Number.isInteger(o.targetBps)) {
                    return void errors.push(`themes[${i}].targetBps must be an integer`);
                }
                parsed.push({ id: o.id.trim(), targetBps: o.targetBps });
            });
            if (errors.length === 0) themes = parsed;
        }
    }

    let investOnlyWhenAhead = current.investOnlyWhenAhead;
    if (b.investOnlyWhenAhead !== undefined) {
        if (typeof b.investOnlyWhenAhead !== "boolean") errors.push("investOnlyWhenAhead must be true or false");
        else investOnlyWhenAhead = b.investOnlyWhenAhead;
    }

    /**
     * An exit rule, which `null` removes.
     *
     * Removal has to be expressible. These are the only terms whose absence means something specific,
     * namely that the agent may not sell on its own at all, and an owner who sets a stop loss by mistake
     * needs a way back to that state. `validateTerms` decides whether the number itself is allowed.
     */
    const exitField = (name: "takeProfitBps" | "stopLossBps"): number | undefined => {
        const v = b[name];
        if (v === undefined) return current[name];
        if (v === null) return undefined;
        if (typeof v !== "number" || !Number.isInteger(v)) {
            errors.push(`${name} must be an integer number of basis points, or null to remove it`);
            return current[name];
        }
        return v;
    };
    const takeProfitBps = exitField("takeProfitBps");
    const stopLossBps = exitField("stopLossBps");

    const terms: MandateTerms = {
        eligible,
        themes,
        maxCompanyBps: intField("maxCompanyBps", current.maxCompanyBps),
        investShareBps: intField("investShareBps", current.investShareBps),
        maxSlippageBps: intField("maxSlippageBps", current.maxSlippageBps),
        driftToleranceBps: intField("driftToleranceBps", current.driftToleranceBps),
        approvalExpirySeconds: intField("approvalExpirySeconds", current.approvalExpirySeconds),
        maxTradeUsdc: amountField("maxTradeUsdc", current.maxTradeUsdc),
        minTradeUsdc: amountField("minTradeUsdc", current.minTradeUsdc),
        reserveTargetUsdc: amountField("reserveTargetUsdc", current.reserveTargetUsdc),
        ...(investOnlyWhenAhead === undefined ? {} : { investOnlyWhenAhead }),
        ...(takeProfitBps === undefined ? {} : { takeProfitBps }),
        ...(stopLossBps === undefined ? {} : { stopLossBps }),
    };

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, terms };
}

/** Names of the terms that differ, so an owner can see what their update actually changed. */
export function changedTerms(before: MandateTerms, after: MandateTerms): string[] {
    const out: string[] = [];
    const show = (v: unknown): string => (typeof v === "bigint" ? v.toString() : JSON.stringify(v));
    for (const key of Object.keys(before) as (keyof MandateTerms)[]) {
        if (show(before[key]) !== show(after[key])) out.push(`${key}: ${show(before[key])} -> ${show(after[key])}`);
    }
    return out;
}
