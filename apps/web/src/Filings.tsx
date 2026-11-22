import { useEffect, useMemo, useState } from "react";
import { Button, Chip, Figures, Footer, Led, Note, OpenApp, SiteHeader, Spine } from "./Chrome";
import { MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { get } from "./api";

interface Filing {
    id: string;
    title: string;
    publisher: string;
    url: string;
    publishedAt: string | null;
    citedBy: number;
}

type Load = { k: "loading" } | { k: "ready"; filings: Filing[]; briefs: number } | { k: "down" };

/**
 * Every document the agent has actually read.
 *
 * This is the page that makes the rest of the site checkable. A brief's claims are only worth what
 * their sources are worth, and here they are: the real filings, newest first, each linking out to
 * the copy on EDGAR rather than to anything this server stores. Nobody has to trust a summary.
 */
export function Filings() {
    const [load, setLoad] = useState<Load>({ k: "loading" });
    const [query, setQuery] = useState("");

    useEffect(() => {
        get<{ filings: Filing[]; briefs: number }>("/catalogue/filings")
            .then((r) => setLoad({ k: "ready", filings: r.filings, briefs: r.briefs }))
            .catch(() => setLoad({ k: "down" }));
    }, []);

    const filings = load.k === "ready" ? load.filings : [];
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q === "") return filings;
        return filings.filter((f) => `${f.title} ${f.publisher}`.toLowerCase().includes(q));
    }, [filings, query]);

    // Not a count of publishers: they are all SEC EDGAR, and a figure that is always 1 is furniture.
    // How often these documents are leaned on says something the list does not.
    const citations = filings.reduce((a, f) => a + f.citedBy, 0);
    const newest = filings.find((f) => f.publishedAt !== null)?.publishedAt ?? null;

    return (
        <>
            <SiteHeader
                here="filings"
                right={
                    <>
                        <Chip><Led />{load.k === "ready" ? `${filings.length} read` : "reading"}</Chip>
                        <OpenApp />
                    </>
                }
            />

            <main id="main">
                <section className="border-b border-line">
                    <div className="shell band py-[clamp(2.25rem,5vw,3.25rem)]">
                        <Spine label="Filings" aside="Primary documents, straight from the source." />
                        <motion.div variants={stagger()} initial="hidden" animate="shown" className="min-w-0">
                            <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                <MaskedLine delay={0.1}>Everything it has read.</MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                Every 10-K and 10-Q behind every brief, with a link to the copy on SEC EDGAR. Nothing
                                here is a summary, and no claim in a brief exists without one of these under it.
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
                        { k: "Filings read", v: load.k === "ready" ? String(filings.length) : "—" },
                        { k: "Citations", v: load.k === "ready" ? String(citations) : "—", unit: "across the briefs" },
                        { k: "Newest filing", v: newest ?? "—" },
                        { k: "Briefs built on them", v: load.k === "ready" ? String(load.briefs) : "—" },
                    ]}
                />

                <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine
                            label="The documents"
                            aside={
                                <>
                                    Newest first. An undated filing sorts last rather than pretending to be old.
                                    <label className="mt-5 block">
                                        <span className="mb-2 block text-[0.8125rem] text-dim">Filter by company or form</span>
                                        <input
                                            type="search"
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                            placeholder="TSLA, 10-Q…"
                                            className="w-full rounded-[5px] border border-line bg-soot px-3 py-2.5 text-[0.9375rem] text-ink placeholder:text-faint"
                                        />
                                    </label>
                                </>
                            }
                        />
                        <div className="min-w-0">
                            {load.k === "loading" ? (
                                <p className="m-0 font-mono text-sm text-dim" role="status">Reading the catalogue…</p>
                            ) : filings.length === 0 ? (
                                <p className="measure m-0 text-dim">
                                    The agent has not read anything yet. The catalogue is empty, which the page says
                                    rather than filling the space.
                                </p>
                            ) : shown.length === 0 ? (
                                <p className="m-0 text-dim" role="status">
                                    Nothing matches “{query}”. {filings.length} filings are listed without a filter.
                                </p>
                            ) : (
                                <>
                                    <p className="m-0 font-mono text-xs text-dim" aria-live="polite">
                                        {shown.length === filings.length
                                            ? `${filings.length} filings`
                                            : `${shown.length} of ${filings.length} filings`}
                                    </p>
                                    <div className="mt-4 border-t border-line">
                                        {shown.map((f, i) => <FilingLine key={f.id} filing={f} delay={Math.min(i, 10) * 0.03} />)}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </section>

                <section className="border-t border-line py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine label="What it does with them" />
                        <div className="min-w-0">
                            <Reveal>
                                <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] font-medium leading-[1.12] tracking-[-0.035em]">
                                    A filing is where a claim has to come from.
                                </h2>
                                <p className="measure mt-4">
                                    A fact survives only if 20 to 300 characters of one of these documents appear
                                    verbatim under it, and every number in the fact appears in those quotes. Anything
                                    else is dropped before a buyer sees it.
                                </p>
                                <div className="mt-6 flex flex-wrap items-center gap-3">
                                    <Button href="/themes" tone="ghost">See the themes</Button>
                                    <OpenApp size="md" />
                                </div>
                            </Reveal>
                        </div>
                    </div>
                </section>
            </main>

            <Footer>
                <span>Filing text is quoted from SEC EDGAR. Links go to the source, not to a copy held here.</span>
                <span>Research is informational and is not investment advice.</span>
            </Footer>
        </>
    );
}

/**
 * One filing. The link leaves for EDGAR, and only if the URL really is one.
 *
 * Source documents are untrusted data everywhere else in this project, and a URL is no exception: a
 * `javascript:` href from a document the agent read would be a script this page ran. Anything that
 * is not plain http or https is shown as text instead.
 */
function FilingLine({ filing, delay }: { filing: Filing; delay: number }) {
    const safe = isWebUrl(filing.url);
    return (
        <Reveal delay={delay}>
            <div className="grid gap-x-6 gap-y-1.5 border-b border-line py-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:items-baseline">
                <span className="num font-mono text-[0.8125rem] text-dim">{filing.publishedAt ?? "undated"}</span>
                <span className="min-w-0">
                    {safe ? (
                        <a
                            href={filing.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[0.9375rem] text-ink no-underline [border-bottom:1px_solid_var(--color-line)] hover:[border-bottom-color:var(--color-lime)]"
                        >
                            {filing.title} <span aria-hidden="true">↗</span>
                        </a>
                    ) : (
                        <span className="text-[0.9375rem] text-ink">{filing.title}</span>
                    )}
                    <span className="mt-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-dim">
                        {filing.publisher}
                    </span>
                </span>
                <span className="font-mono text-xs text-dim sm:text-right">
                    cited by {filing.citedBy} {filing.citedBy === 1 ? "brief" : "briefs"}
                </span>
            </div>
        </Reveal>
    );
}

function isWebUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
        return false;
    }
}
