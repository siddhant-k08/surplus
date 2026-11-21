import { mulBps } from "./money";
import { validateTerms, type MandateTerms } from "./mandate";
import type { Leg } from "./policy";

export interface Candidate {
    asset: string;
    symbol: string;
    weight: number; // positive integer, e.g. rank score * 100
}

export interface ThemeInput {
    id: string;
    candidates: readonly Candidate[];
}

export interface AllocationInput {
    investable: bigint;
    themes: readonly ThemeInput[];
    terms: MandateTerms;
    /**
     * What is already held per asset, in the USDC that bought it.
     *
     * The company cap is a limit on exposure to one company, so it has to count what the agent already
     * holds. Without this each allocation respected the cap on its own and successive proposals could
     * build a position far beyond it.
     */
    held?: ReadonlyMap<string, bigint>;
}

export type UninvestedReason =
    | "gap"
    | "company_cap"
    | "max_trade"
    | "below_minimum"
    | "unassigned";

export interface Uninvested {
    theme: string | null;
    amount: bigint;
    reason: UninvestedReason;
}

export interface AllocationResult {
    legs: Leg[];
    uninvested: Uninvested[];
}

interface Slot {
    asset: string;
    symbol: string;
    weight: bigint;
    cap: bigint;
    capReason: "company_cap" | "max_trade";
    amount: bigint;
}

/** Spreads budget by weight, respecting each slot's cap. Returns what could not be placed. */
function waterFill(budget: bigint, slots: Slot[]): bigint {
    let remaining = budget;
    let active = slots.filter((s) => s.cap > 0n);
    while (remaining > 0n && active.length > 0) {
        const totalW = active.reduce((a, s) => a + s.weight, 0n);
        const shares = active.map((s) => (remaining * s.weight) / totalW);
        let leftover = remaining - shares.reduce((a, b) => a + b, 0n);
        const order = active
            .map((_, i) => i)
            .sort((i, j) => Number(active[j]!.weight - active[i]!.weight) || i - j);
        for (const i of order) {
            if (leftover === 0n) break;
            shares[i] = shares[i]! + 1n;
            leftover -= 1n;
        }
        let placed = 0n;
        const stillActive: Slot[] = [];
        active.forEach((s, i) => {
            const want = shares[i]!;
            const room = s.cap - s.amount;
            if (want >= room) {
                s.amount += room;
                placed += room;
            } else {
                s.amount += want;
                placed += want;
                stillActive.push(s);
            }
        });
        remaining -= placed;
        active = stillActive;
    }
    return remaining;
}

export function allocate(input: AllocationInput): AllocationResult {
    const { investable, terms } = input;
    validateTerms(terms);
    if (investable < 0n) throw new Error("investable must not be negative");

    const eligible = new Set(terms.eligible.map((a) => a.toLowerCase()));
    const targeted = new Set(terms.themes.map((t) => t.id));
    for (const th of input.themes) {
        if (!targeted.has(th.id)) throw new Error(`Theme "${th.id}" has no target in the mandate`);
    }

    // The cap is measured against everything the agent would then hold, not just this allocation.
    const held = input.held ?? new Map<string, bigint>();
    const heldTotal = [...held.values()].reduce((a, v) => a + v, 0n);
    const companyCap = mulBps(investable + heldTotal, terms.maxCompanyBps);
    const used = new Map<string, bigint>();
    for (const [asset, amount] of held) {
        if (amount < 0n) throw new Error(`held amount for ${asset} must not be negative`);
        used.set(asset.toLowerCase(), amount);
    }
    const legs: Leg[] = [];
    const uninvested: Uninvested[] = [];
    let budgetTotal = 0n;

    for (const target of terms.themes) {
        const budget = mulBps(investable, target.targetBps);
        budgetTotal += budget;
        if (budget === 0n) continue;

        const theme = input.themes.find((t) => t.id === target.id);
        const cands = (theme?.candidates ?? []).filter((c) => eligible.has(c.asset.toLowerCase()));
        if (cands.length === 0) {
            uninvested.push({ theme: target.id, amount: budget, reason: "gap" });
            continue;
        }

        const seen = new Set<string>();
        const slots: Slot[] = cands.map((c) => {
            if (!Number.isInteger(c.weight) || c.weight <= 0) {
                throw new Error(`Weight for ${c.symbol} must be a positive integer`);
            }
            const asset = c.asset.toLowerCase();
            if (seen.has(asset)) throw new Error(`Duplicate candidate ${c.symbol} in theme "${target.id}"`);
            seen.add(asset);
            const left = companyCap - (used.get(asset) ?? 0n);
            const companyRoom = left > 0n ? left : 0n;
            const byCompany = companyRoom <= terms.maxTradeUsdc;
            return {
                asset,
                symbol: c.symbol,
                weight: BigInt(c.weight),
                cap: byCompany ? companyRoom : terms.maxTradeUsdc,
                capReason: byCompany ? "company_cap" : "max_trade",
                amount: 0n,
            };
        });

        const remaining = waterFill(budget, slots);
        if (remaining > 0n) {
            // name the constraint that actually bound: only slots sitting at their cap held money back
            const atCap = slots.filter((s) => s.amount >= s.cap);
            const reason = atCap.some((s) => s.capReason === "company_cap") ? "company_cap" : "max_trade";
            uninvested.push({ theme: target.id, amount: remaining, reason });
        }

        for (const s of slots) {
            if (s.amount === 0n) continue;
            if (s.amount < terms.minTradeUsdc) {
                uninvested.push({ theme: target.id, amount: s.amount, reason: "below_minimum" });
                continue;
            }
            used.set(s.asset, (used.get(s.asset) ?? 0n) + s.amount);
            legs.push({
                asset: s.asset,
                symbol: s.symbol,
                theme: target.id,
                usdcIn: s.amount,
                maxSlippageBps: terms.maxSlippageBps,
            });
        }
    }

    const unassigned = investable - budgetTotal;
    if (unassigned > 0n) uninvested.push({ theme: null, amount: unassigned, reason: "unassigned" });
    return { legs, uninvested };
}