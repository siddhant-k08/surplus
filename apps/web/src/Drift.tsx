import { useState } from "react";
import { Reveal } from "./motion";
import { api, ApiError, type DriftReading, type ThemeDrift } from "./api";
import { bpsToPercent } from "./terms";

/**
 * Where the themes actually sit, next to the band the owner is choosing.
 *
 * A rebalance band set without this is set blind: five percent sounds careful until you can see the
 * portfolio is one basis point off target, at which point it is obvious that nothing will ever trim.
 * So the reading belongs beside the field, and it has to work when the mandate carries no band at all,
 * which is exactly when an owner needs it most.
 *
 * Read on demand. It costs one live sell quote per token held, and a mandate page opened to change the
 * reserve should not spend that.
 */

/**
 * Whether a theme sits outside a band the owner is considering but has not saved.
 *
 * Deliberately weaker than the reading's own `overBand`, which is the authoritative answer: the server
 * also requires the excess to be worth more than the mandate's minimum trade, because a theme can be
 * outside its band by an amount too small to be worth selling. This says "outside the band" and must
 * not be worded as "would be trimmed".
 */
export function outsideBand(t: ThemeDrift, bandBps: number | undefined): boolean {
    return bandBps !== undefined && t.driftBps > bandBps;
}

/** The drift as a person reads it: above, below, or on target. */
export function driftWords(driftBps: number): string {
    if (driftBps === 0) return "on target";
    const size = bpsToPercent(Math.abs(driftBps));
    return `${size}% ${driftBps > 0 ? "above" : "below"} target`;
}

/**
 * One line saying whether anything is out of line, in the units the owner is thinking in.
 *
 * `bandBps` is what is in the form, which may not be what is saved, so the sentence says which band it
 * is talking about rather than leaving the reader to assume.
 */
export function driftSummary(reading: DriftReading, bandBps: number | undefined): string {
    if (reading.themes.length === 0) return "Nothing is held yet, so there are no weights to compare.";
    if (bandBps === undefined) {
        return "No band is set, so no theme is trimmed however far it drifts.";
    }
    const out = reading.themes.filter((t) => outsideBand(t, bandBps));
    if (out.length === 0) {
        return `Every theme is inside a ${bpsToPercent(bandBps)}% band, so nothing would be trimmed.`;
    }
    return `${out.map((t) => t.theme).join(" and ")} ${out.length === 1 ? "sits" : "sit"} outside a ` +
        `${bpsToPercent(bandBps)}% band.`;
}

const usdc = (minor: string): string => (Number(minor) / 1e6).toFixed(6);

export function DriftPanel({ bandBps }: { bandBps: number | undefined }) {
    const [reading, setReading] = useState<DriftReading | null>(null);
    const [state, setState] = useState<"idle" | "reading" | "failed">("idle");
    const [why, setWhy] = useState("");

    async function read() {
        setState("reading");
        setWhy("");
        try {
            setReading(await api.drift());
            setState("idle");
        } catch (e) {
            setState("failed");
            setWhy(e instanceof ApiError && e.reasons.length > 0
                ? e.reasons.join(", ")
                : e instanceof Error ? e.message : String(e));
        }
    }

    return (
        <Reveal>
            <div className="mt-6 rounded-card border border-line bg-surface p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h2 className="text-base font-semibold">Where your themes sit now</h2>
                    <button type="button" onClick={() => void read()} disabled={state === "reading"}
                        className="border-0 bg-transparent py-1 text-sm text-dim underline decoration-transparent underline-offset-4 transition-colors hover:text-ink hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-45">
                        {state === "reading" ? "Reading live quotes…" : reading === null ? "Read live quotes" : "Read again"}
                    </button>
                </div>

                {reading === null && state !== "failed" && (
                    <p className="mt-2 text-sm text-dim">
                        Prices move the weights after the money is allocated, and only a live quote says by
                        how much. One quote per token held, so this is asked for rather than loaded with the
                        page.
                    </p>
                )}

                {state === "failed" && (
                    <p className="mt-2 text-sm text-flag" role="alert">
                        The weights could not be read: {why}. The books are unaffected, since nothing was
                        proposed.
                    </p>
                )}

                {reading !== null && (
                    <div aria-live="polite">
                        <p className="mt-2 text-sm text-dim">{driftSummary(reading, bandBps)}</p>
                        <div className="mt-4 grid gap-3.5">
                            {reading.themes.map((t) => (
                                <ThemeRow key={t.theme} theme={t} bandBps={bandBps} />
                            ))}
                        </div>
                        <p className="mt-4 text-[0.8125rem] leading-relaxed text-dim">
                            {usdc(reading.totalUsdcMinor)} USDC across {reading.themes.length}{" "}
                            {reading.themes.length === 1 ? "theme" : "themes"}, measured against the portfolio
                            rather than the portfolio plus idle cash, with targets shared out over the themes
                            that actually hold something.
                            {Number(reading.untargetedUsdcMinor) > 0 && (
                                <> {usdc(reading.untargetedUsdcMinor)} USDC is held under no theme the mandate
                                funds, so it belongs to no target and is never trimmed.</>
                            )}
                        </p>
                    </div>
                )}
            </div>
        </Reveal>
    );
}

function ThemeRow({ theme: t, bandBps }: { theme: ThemeDrift; bandBps: number | undefined }) {
    const out = outsideBand(t, bandBps);
    // Drawn, not animated. A bar whose width animates from a number to a percentage settles at the
    // wrong value, which was a real bug on the backing bars.
    const width = `${Math.min(100, t.actualBps / 100)}%`;
    const target = `${Math.min(100, t.targetBps / 100)}%`;
    return (
        <div className="grid gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[0.9375rem] font-medium text-ink">{t.theme}</span>
                <span className={`num font-mono text-[0.8125rem] ${out ? "text-flag" : "text-dim"}`}>
                    {bpsToPercent(t.actualBps)}% of {bpsToPercent(t.targetBps)}% · {driftWords(t.driftBps)}
                </span>
            </div>
            {/*
              * The target sits under the bar rather than inside it. A marker drawn over the fill has to
              * be legible against both the lime of a theme on target and the coral of one that is not,
              * and a single colour cannot be. Below the bar it is always on the same ground.
              */}
            <div className="relative pb-2">
                <div className="h-2 overflow-hidden rounded-full bg-soot">
                    <div className={`h-full rounded-full ${out ? "bg-flag" : "bg-lime"}`} style={{ width }} />
                </div>
                <div className="absolute bottom-0 h-1.5 w-0.5 -translate-x-1/2 rounded-full bg-dim"
                    style={{ left: target }} aria-hidden="true" />
            </div>
            {out && (
                <small className="text-[0.8125rem] text-dim">
                    Outside the band you have typed. Whether it is actually trimmed also depends on the
                    excess being worth more than your smallest trade.
                </small>
            )}
        </div>
    );
}
