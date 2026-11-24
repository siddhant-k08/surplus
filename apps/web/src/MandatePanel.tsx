import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Button } from "./Chrome";
import { Reveal , motion } from "./motion";
import { count } from "./Evidence";
import { api, ApiError, type ExitTerm, type Mandate, type MandateHistory, type MandateTerms } from "./api";
import {
    bpsToPercent, changedOnly, describeChange, EXIT_TERMS, formatAddresses, formatExitPercent,
    formatThemeTargets, isAmount, LABELS, parseAddresses, parseExitPercent, parseThemeTargets,
    percentToBps, toSeconds,
} from "./terms";

/**
 * The owner's constraints, readable and editable.
 *
 * The agent never touches these: a mandate version is only ever created from the owner's own request,
 * which is what makes an approval signature mean anything. So this panel does three things and no more.
 * It shows every term the mandate actually carries, it sends only the ones the owner changed, and it
 * shows the review before the save rather than the consequences after it.
 *
 * Validation stays on the server. The form checks shapes so it can refuse to send something malformed,
 * but the rules about what is a legal mandate live in core and their refusals are shown verbatim.
 */

type Draft = Record<string, string> & { investOnlyWhenAhead?: string };

const BPS_FIELDS = [
    { key: "investShareBps", hint: "Of the surplus left after costs and the reserve, how much may be invested." },
    { key: "maxCompanyBps", hint: "Ceiling on total exposure to one company, counting what is already held." },
    { key: "maxSlippageBps", hint: "Worst execution price accepted against the quote." },
    { key: "driftToleranceBps", hint: "How far the price may move before your signature stops being valid." },
] as const;

const EXIT_FIELDS = [
    { key: "takeProfitBps", hint: "Sell a holding once it is up this much on what was paid for it." },
    { key: "stopLossBps", hint: "Sell a holding once it is down this much. Below 100%, since a position cannot lose more than all of it." },
    { key: "rebalanceBandBps", hint: "How far a theme may sit above its target share before it is trimmed back. Only ever sells, spread across that theme's holdings in proportion." },
] as const;

const AMOUNT_FIELDS = [
    { key: "reserveTargetUsdc", hint: "Filled from revenue before any surplus exists. Never invested." },
    { key: "minTradeUsdc", hint: "Below this, gas eats the trade, so the money stays uninvested." },
    { key: "maxTradeUsdc", hint: "No single swap may exceed this, however much is investable." },
] as const;

function draftFrom(terms: MandateTerms): Draft {
    return {
        investShareBps: bpsToPercent(terms.investShareBps),
        maxCompanyBps: bpsToPercent(terms.maxCompanyBps),
        maxSlippageBps: bpsToPercent(terms.maxSlippageBps),
        driftToleranceBps: bpsToPercent(terms.driftToleranceBps),
        reserveTargetUsdc: terms.reserveTargetUsdc,
        minTradeUsdc: terms.minTradeUsdc,
        maxTradeUsdc: terms.maxTradeUsdc,
        approvalExpirySeconds: String(terms.approvalExpirySeconds),
        themes: formatThemeTargets(terms.themes),
        eligible: formatAddresses(terms.eligible),
        investOnlyWhenAhead: terms.investOnlyWhenAhead === true ? "yes" : "no",
        takeProfitBps: formatExitPercent(terms.takeProfitBps),
        stopLossBps: formatExitPercent(terms.stopLossBps),
        rebalanceBandBps: formatExitPercent(terms.rebalanceBandBps),
    };
}

/** The draft as terms, or the list of fields that are not a shape the server would accept. */
export function termsFromDraft(
    current: MandateTerms,
    draft: Draft,
): { ok: true; terms: MandateTerms } | { ok: false; bad: string[] } {
    const bad: string[] = [];
    const bps = (key: (typeof BPS_FIELDS)[number]["key"]): number => {
        const v = percentToBps(draft[key] ?? "");
        if (v === null) {
            bad.push(`${LABELS[key]} must be a percentage from 0 to 100, with at most two decimals`);
            return current[key];
        }
        return v;
    };
    const amount = (key: (typeof AMOUNT_FIELDS)[number]["key"]): string => {
        const v = (draft[key] ?? "").trim();
        if (!isAmount(v)) {
            bad.push(`${LABELS[key]} must be an amount like 1.50, with at most six decimals`);
            return current[key];
        }
        return v;
    };
    /*
     * The exit rules, where an empty box is a legal answer meaning the agent may not sell on that rule.
     *
     * A malformed box keeps whatever the mandate already says rather than falling through to nothing.
     * The save is blocked either way, but a typo must never read in the review as "take profit removed".
     */
    const exit: { -readonly [K in ExitTerm]?: number } = {};
    for (const key of EXIT_TERMS) {
        const rule = parseExitPercent(draft[key] ?? "");
        if (!rule.ok) {
            bad.push(`${LABELS[key]} must be a percentage above zero, or empty for no rule`);
            if (current[key] !== undefined) exit[key] = current[key];
            continue;
        }
        if (rule.bps !== undefined) exit[key] = rule.bps;
    }
    if (exit.stopLossBps !== undefined && exit.stopLossBps >= 10_000) {
        bad.push("Stop loss must be below 100%, since a position cannot lose more than all of it");
    }

    const seconds = toSeconds(draft.approvalExpirySeconds ?? "");
    if (seconds === null) bad.push("Approval expiry must be a whole number of seconds above zero");
    const themes = parseThemeTargets(draft.themes ?? "");
    if (themes === null) bad.push("Each theme needs a name and a percentage, one per line, like: ai-compute 50");
    const eligible = parseAddresses(draft.eligible ?? "");
    if (eligible.length === 0) bad.push("At least one eligible token address is required");

    const terms: MandateTerms = {
        eligible,
        themes: themes ?? [...current.themes],
        maxCompanyBps: bps("maxCompanyBps"),
        investShareBps: bps("investShareBps"),
        maxSlippageBps: bps("maxSlippageBps"),
        driftToleranceBps: bps("driftToleranceBps"),
        approvalExpirySeconds: seconds ?? current.approvalExpirySeconds,
        maxTradeUsdc: amount("maxTradeUsdc"),
        minTradeUsdc: amount("minTradeUsdc"),
        reserveTargetUsdc: amount("reserveTargetUsdc"),
        ...(draft.investOnlyWhenAhead === undefined
            ? {}
            : { investOnlyWhenAhead: draft.investOnlyWhenAhead === "yes" }),
        ...exit,
    };
    return bad.length > 0 ? { ok: false, bad } : { ok: true, terms };
}

export function MandatePanel({ mandate, onSaved }: { mandate: Mandate; onSaved: (m: Mandate) => void }) {
    const [draft, setDraft] = useState<Draft>(() => draftFrom(mandate.terms));
    const [history, setHistory] = useState<MandateHistory | null>(null);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [saved, setSaved] = useState<{ version: number; changed: string[]; note: string } | null>(null);

    // A new version, from here or elsewhere, resets the form to what the mandate now says. Keeping
    // stale edits on screen after the terms moved would let an owner save a value they never saw.
    useEffect(() => { setDraft(draftFrom(mandate.terms)); }, [mandate]);
    useEffect(() => { api.mandateHistory().then(setHistory).catch(() => setHistory(null)); }, [mandate.version]);

    const parsed = useMemo(() => termsFromDraft(mandate.terms, draft), [mandate.terms, draft]);
    const changes = useMemo(() => (parsed.ok ? changedOnly(mandate.terms, parsed.terms) : {}), [parsed, mandate.terms]);
    const changedKeys = Object.keys(changes) as (keyof MandateTerms)[];
    const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

    async function save() {
        if (!parsed.ok || changedKeys.length === 0) return;
        setSaving(true);
        setErrors([]);
        try {
            // never retried: a second POST would create a second version
            const result = await api.updateMandate(changes);
            setSaved({ version: result.version, changed: result.changed, note: result.note });
            onSaved(result);
        } catch (e) {
            setErrors(e instanceof ApiError && e.reasons.length > 0 ? e.reasons : [e instanceof Error ? e.message : String(e)]);
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
            <div className="shell">
                <Reveal>
                    <div className="mb-4 flex flex-wrap items-baseline gap-3.5">
                        <h1 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium tracking-[-0.035em]">Your mandate</h1>
                        <span className="num rounded-full border border-dashed border-line px-2.5 py-1 font-mono text-[0.6875rem] text-dim">
                            v{mandate.version} · {mandate.hash.slice(0, 10)}
                        </span>
                    </div>
                    <p className="measure mb-8">
                        The agent never changes these. Every proposal is checked against them, and your signature
                        covers the version they were in, so changing a term invalidates anything outstanding.
                    </p>
                </Reveal>

                <div className="grid gap-5 lg:grid-cols-2">
                    <Group title="How much, and into what">
                        {BPS_FIELDS.slice(0, 2).map((f) => (
                            <Field key={f.key} id={f.key} label={LABELS[f.key]} hint={f.hint} suffix="%"
                                value={draft[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
                        ))}
                        <Field id="themes" label="Themes and their targets" rows={4}
                            hint="One per line: a theme name, then its share as a percentage. Targets may total less than 100 but never more."
                            value={draft.themes ?? ""} onChange={(v) => set("themes", v)} />
                    </Group>

                    <Group title="Limits on a trade">
                        {AMOUNT_FIELDS.map((f) => (
                            <Field key={f.key} id={f.key} label={LABELS[f.key]} hint={f.hint} suffix="USDC"
                                value={draft[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
                        ))}
                    </Group>

                    <Group title="When to sell">
                        <p className="m-0 text-[0.8125rem] leading-relaxed text-dim">
                            Leave a box empty and the agent will not sell on that rule. With all three empty it
                            proposes no sale at all: silence is not permission, so an exit has to be one you set
                            or one you ask for by name.
                        </p>
                        {EXIT_FIELDS.map((f) => (
                            <Field key={f.key} id={f.key} label={LABELS[f.key]} hint={f.hint} suffix="%"
                                value={draft[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
                        ))}
                    </Group>

                    <Group title="Execution and your signature">
                        {BPS_FIELDS.slice(2).map((f) => (
                            <Field key={f.key} id={f.key} label={LABELS[f.key]} hint={f.hint} suffix="%"
                                value={draft[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
                        ))}
                        <Field id="approvalExpirySeconds" label={LABELS.approvalExpirySeconds} suffix="seconds"
                            hint={`How long a signature stays good for. ${expiryWords(draft.approvalExpirySeconds ?? "")}`}
                            value={draft.approvalExpirySeconds ?? ""} onChange={(v) => set("approvalExpirySeconds", v)} />
                        <label className="flex items-start gap-3">
                            <input type="checkbox" checked={draft.investOnlyWhenAhead === "yes"}
                                onChange={(e) => set("investOnlyWhenAhead", e.target.checked ? "yes" : "no")}
                                className="mt-1 size-4 shrink-0 accent-[var(--color-lime)]" />
                            <span>
                                <b className="block text-[0.9375rem] font-medium text-ink">{LABELS.investOnlyWhenAhead}</b>
                                <small className="mt-1 block text-[0.8125rem] leading-relaxed text-dim">
                                    Refuse to invest while the agent has spent more over its life than it has earned,
                                    even when one brief sold well enough to show a surplus.
                                </small>
                            </span>
                        </label>
                    </Group>

                    <div className="lg:col-span-2 grid">
                    <Group title="Eligible tokens">
                        <Field id="eligible" label={`One token address per line · ${mandate.terms.eligible.length} now`} rows={6} mono
                            hint="Base's official registry crossed with the Coinbase tokenized stocks API. Removing an address stops the agent buying it; it does not sell what is held."
                            value={draft.eligible ?? ""} onChange={(v) => set("eligible", v)} />
                    </Group>
                    </div>
                </div>

                {/* The review, before the save. */}
                <div className="mt-6 rounded-card border border-line border-l-[3px] border-l-lime bg-surface p-5" aria-live="polite">
                    {!parsed.ok ? (
                        <>
                            <h3 className="text-base font-semibold text-flag">Not ready to save</h3>
                            <ul className="mt-2 grid list-disc gap-1 pl-5 text-[0.9375rem] text-dim">
                                {parsed.bad.map((b) => <li key={b}>{b}</li>)}
                            </ul>
                        </>
                    ) : changedKeys.length === 0 ? (
                        <p className="m-0 text-sm text-dim">Nothing is changed, so there is nothing to save.</p>
                    ) : (
                        <>
                            <h3 className="text-base font-semibold">
                                {changedKeys.length === 1 ? "One change to save" : `${changedKeys.length} changes to save`}
                            </h3>
                            <ul className="mt-2 grid list-disc gap-1 pl-5 text-[0.9375rem] text-dim">
                                {changedKeys.map((k) => <li key={k}>{describeChange(k, mandate.terms, parsed.terms)}</li>)}
                            </ul>
                            <p className="mt-3 text-sm text-dim">
                                Saving writes mandate v{mandate.version + 1}. Any proposal you have already signed stops
                                being valid and has to be approved again.
                            </p>
                        </>
                    )}
                    <div className="mt-5 flex flex-wrap items-center gap-4">
                        <Button onClick={() => void save()} disabled={saving || !parsed.ok || changedKeys.length === 0}>
                            {saving ? "Saving…" : `Save as v${mandate.version + 1}`} <span aria-hidden="true">↗</span>
                        </Button>
                        <button type="button" onClick={() => setDraft(draftFrom(mandate.terms))}
                            disabled={saving || changedKeys.length === 0}
                            className="border-0 bg-transparent py-2 text-sm text-dim underline decoration-transparent underline-offset-4 transition-colors hover:text-ink hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-45">
                            Discard my edits
                        </button>
                    </div>

                    <AnimatePresence>
                        {errors.length > 0 && (
                            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                                className="mt-4 text-sm text-flag" role="alert">
                                <strong>The mandate was not changed.</strong>
                                <ul className="mt-1 grid list-disc gap-1 pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                            </motion.div>
                        )}
                        {saved !== null && (
                            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                                className="mt-4 text-sm text-lime" role="status">
                                <strong>Saved as v{saved.version}.</strong> {saved.note}
                                <ul className="mt-1 grid list-disc gap-1 pl-5">{saved.changed.map((c) => <li key={c}>{c}</li>)}</ul>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                <h2 className="mt-12 text-xl font-semibold tracking-[-0.02em]">Version history</h2>
                {history === null ? (
                    <p className="mt-3 text-sm text-dim">Reading the history…</p>
                ) : (
                    <>
                        <p className={`mt-3 text-sm ${history.chainVerified ? "text-lime" : "text-flag"}`}>
                            {history.chainVerified
                                ? "Every version hashes onto the one before it, so nothing has been edited behind your back."
                                : "The stored history does not verify. A version has been altered or removed, and the agent refuses to start against it."}
                        </p>
                        <div className="mt-4 border-t border-line">
                            {[...history.versions].reverse().map((v) => (
                                <div key={v.version} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-3.5">
                                    <span className="num min-w-[3rem] font-mono text-sm text-ink">v{v.version}</span>
                                    <span className="flex-1 text-sm text-dim">
                                        {new Date(v.createdAt).toLocaleString()} · {bpsToPercent(v.terms.investShareBps)}% share,
                                        reserve {v.terms.reserveTargetUsdc} USDC, {count(v.terms.themes.length, "theme")}
                                    </span>
                                    <span className="num font-mono text-xs text-dim" title={v.hash}>{v.hash.slice(0, 10)}</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </section>
    );
}

function expiryWords(seconds: string): string {
    const n = toSeconds(seconds);
    if (n === null) return "";
    if (n < 60) return `That is ${n} seconds.`;
    const m = Math.floor(n / 60);
    const r = n % 60;
    return `That is ${m} minute${m === 1 ? "" : "s"}${r === 0 ? "" : ` ${r} seconds`}.`;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <fieldset className="m-0 grid content-start gap-5 rounded-card border border-line bg-surface p-5">
            <legend className="px-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-dim">
                {title}
            </legend>
            {children}
        </fieldset>
    );
}

function Field({
    id, label, hint, value, onChange, suffix, rows, mono,
}: {
    id: string; label: string; hint: string; value: string; onChange: (v: string) => void;
    suffix?: string; rows?: number; mono?: boolean;
}) {
    const box = "w-full rounded-[6px] border border-line bg-soot px-3 py-2.5 text-[0.9375rem] text-ink";
    return (
        <div className="grid gap-1.5">
            <label htmlFor={id} className="text-[0.9375rem] font-medium text-ink">{label}</label>
            {rows === undefined ? (
                <span className="flex items-center gap-2">
                    <input id={id} value={value} inputMode="decimal" aria-describedby={`${id}-hint`}
                        onChange={(e) => onChange(e.target.value)} className={`${box} max-w-[9rem]`} />
                    {suffix !== undefined && <span className="text-[0.8125rem] text-dim">{suffix}</span>}
                </span>
            ) : (
                <textarea id={id} rows={rows} value={value} aria-describedby={`${id}-hint`}
                    onChange={(e) => onChange(e.target.value)}
                    className={`${box} resize-y ${mono === true ? "font-mono text-[0.8125rem]" : ""}`} />
            )}
            <small id={`${id}-hint`} className="text-[0.8125rem] leading-relaxed text-dim">{hint}</small>
        </div>
    );
}
