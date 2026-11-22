import { useEffect, useState } from "react";
import { Button, Chip, Figures, Footer, Led, Note, OpenApp, SiteHeader, Spine } from "./Chrome";
import { MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { get } from "./api";

interface ThemeRow {
    id: string;
    briefs: number;
    companies: number;
    gaps: number;
    symbols: string[];
}

type Load = { k: "loading" } | { k: "ready"; themes: ThemeRow[]; briefs: number } | { k: "down" };

/**
 * Every theme the agent has researched, and which companies reached each one.
 *
 * Public on purpose, and it gives nothing away. A theme id is the name of a question; a symbol is
 * the name of a company. What connects them is a claim with a quote behind it, and that is the
 * product, so it stays behind the paywall. This page is the index, not the contents.
 */
export function Themes() {
    const [load, setLoad] = useState<Load>({ k: "loading" });

    useEffect(() => {
        get<{ themes: ThemeRow[]; briefs: number }>("/catalogue/themes")
            .then((r) => setLoad({ k: "ready", themes: r.themes, briefs: r.briefs }))
            .catch(() => setLoad({ k: "down" }));
    }, []);

    const themes = load.k === "ready" ? load.themes : [];
    const covered = themes.filter((t) => t.companies > 0);
    // A theme is not covered or empty once and for all: the same question can find something in one
    // brief and nothing in the next, so both lists below can name it. Counting only themes that have
    // never found anything would report zero gaps on a catalogue full of them.
    const gapped = themes.filter((t) => t.gaps > 0);
    const emptyRuns = themes.reduce((a, t) => a + t.gaps, 0);
    const symbols = new Set(themes.flatMap((t) => t.symbols));

    return (
        <>
            <SiteHeader
                here="themes"
                right={
                    <>
                        <Chip><Led />{load.k === "ready" ? `${themes.length} researched` : "reading"}</Chip>
                        <OpenApp />
                    </>
                }
            />

            <main id="main">
                <section className="border-b border-line">
                    <div className="shell band py-[clamp(2.25rem,5vw,3.25rem)]">
                        <Spine label="Themes" aside="A theme is a question put to the filings." />
                        <motion.div variants={stagger()} initial="hidden" animate="shown" className="min-w-0">
                            <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                <MaskedLine delay={0.1}>What the agent has researched.</MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                Each theme below was put to real SEC filings. A company appears under one only because a
                                quoted fact from its own filing put it there. The claims and the quotes are what a brief
                                is, so they are not on this page.
                            </motion.p>
                            <motion.div variants={riseItem} className="mt-4" aria-live="polite">
                                {load.k === "down" && (
                                    <Note tone="bad" alert>
                                        Could not reach the agent. It may be restarting; try again shortly.
                                    </Note>
                                )}
                            </motion.div>
                        </motion.div>
                    </div>
                </section>

                <Figures
                    cells={[
                        { k: "Themes researched", v: load.k === "ready" ? String(themes.length) : "—" },
                        { k: "Companies named", v: load.k === "ready" ? String(symbols.size) : "—" },
                        { k: "Came back empty", v: load.k === "ready" ? String(emptyRuns) : "—", unit: "times" },
                        { k: "Briefs behind them", v: load.k === "ready" ? String(load.briefs) : "—" },
                    ]}
                />

                <section className="border-b border-line py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine
                            label="Covered"
                            aside={
                                load.k === "ready"
                                    ? `${covered.length} themes where at least one company cleared the bar.`
                                    : undefined
                            }
                        />
                        <div className="min-w-0">
                            {load.k === "loading" ? (
                                <p className="m-0 font-mono text-sm text-dim" role="status">Reading the catalogue…</p>
                            ) : covered.length === 0 ? (
                                <p className="measure m-0 text-dim">
                                    No theme has a company under it yet. That is not an error: a theme with nothing
                                    quotable behind it is returned as a gap rather than filled.
                                </p>
                            ) : (
                                <div className="border-t border-line">
                                    {covered.map((t, i) => <ThemeLine key={t.id} row={t} delay={Math.min(i, 8) * 0.04} />)}
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {gapped.length > 0 && (
                    <section className="border-b border-line py-[clamp(2.5rem,5vw,3.5rem)]">
                        <div className="shell band">
                            <Spine label="Gaps" aside="Asked, and nothing cleared the evidence bar." />
                            <div className="min-w-0">
                                <Reveal>
                                    <p className="measure m-0">
                                        These themes have come back empty at least once. Nothing was invented to fill
                                        them: an empty answer with its reason is more useful than a confident one with
                                        nothing behind it.
                                    </p>
                                </Reveal>
                                <div className="mt-6 flex flex-wrap gap-2">
                                    {gapped.map((t) => (
                                        <span
                                            key={t.id}
                                            className="rounded-full border border-line px-3 py-1.5 font-mono text-[0.75rem] text-dim"
                                            title={`asked in ${t.briefs} ${t.briefs === 1 ? "brief" : "briefs"}`}
                                        >
                                            {t.id}
                                            <span className="ml-2 text-amber">
                                                {t.gaps} of {t.briefs}
                                            </span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </section>
                )}

                <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine label="Not here?" aside="Themes are researched on request." />
                        <div className="min-w-0">
                            <Reveal>
                                <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] font-medium leading-[1.12] tracking-[-0.035em]">
                                    Ask it something else.
                                </h2>
                                <p className="measure mt-4">
                                    Send your own themes and the agent researches them against the same filings under
                                    the same rules. If yours turns out to be a gap, you get the gap and the reason.
                                </p>
                                <div className="mt-6 flex flex-wrap items-center gap-3">
                                    <Button href="/app#commission">
                                        Commission your themes <span aria-hidden="true">↗</span>
                                    </Button>
                                    <Button href="/filings" tone="ghost">See the filings</Button>
                                </div>
                            </Reveal>
                        </div>
                    </div>
                </section>
            </main>

            <Footer>
                <span>Theme names and company symbols are public. Claims and quotes are what a brief sells.</span>
                <span>Research is informational and is not investment advice.</span>
            </Footer>
        </>
    );
}

/**
 * One theme: its name, what it found, and the companies it found there.
 *
 * The symbols are the point of the row, so they are not hidden behind a disclosure. A theme that is
 * asked in several briefs says so, because a question worth repeating is itself a fact about the
 * catalogue.
 */
function ThemeLine({ row, delay }: { row: ThemeRow; delay: number }) {
    return (
        <Reveal delay={delay}>
            <div className="grid gap-x-6 gap-y-3 border-b border-line py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                    <h3 className="font-mono text-[0.9375rem] font-medium tracking-[-0.01em]">{row.id}</h3>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {row.symbols.map((s) => (
                            <span key={s} className="rounded-[3px] bg-pill px-2 py-1 font-mono text-[0.75rem] text-ink">
                                {s}
                            </span>
                        ))}
                    </div>
                </div>
                <dl className="m-0 flex gap-6 sm:justify-end sm:text-right">
                    <Count k="companies" v={row.companies} />
                    <Count k={row.briefs === 1 ? "brief" : "briefs"} v={row.briefs} />
                    {row.gaps > 0 && <Count k="gaps" v={row.gaps} tone="amber" />}
                </dl>
            </div>
        </Reveal>
    );
}

function Count({ k, v, tone }: { k: string; v: number; tone?: "amber" }) {
    return (
        <div>
            <dd className={`num m-0 font-mono text-[1.25rem] leading-none ${tone === "amber" ? "text-amber" : "text-ink"}`}>
                {v}
            </dd>
            <dt className="mt-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-dim">{k}</dt>
        </div>
    );
}
