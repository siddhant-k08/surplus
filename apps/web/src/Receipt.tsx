import { useEffect, useState } from "react";
import { ApiError, formatUsdc, get, type PaidReceipt } from "./api";
import { EvidenceRow, SourceLink, WhatAQuoteProves, count } from "./Evidence";
import { Button, Chip, Footer, Led, SiteHeader } from "./Chrome";
import { SimulatedNote, ThemeStake, assetStake, forBrief, useBacking, verb } from "./Backing";
import { MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { explorerTx, networkName, shortHash } from "./explorer";

/**
 * What a buyer comes back to. The link is the key; the transaction beside it is proof.
 *
 * The brief is the product, so it is laid out to be read and taken apart: themes as sections,
 * companies as rows, the full evidence inside each. The rail carries the filings, because "which
 * documents did this actually read" is the first question a sceptical reader asks.
 */
export function Receipt({ id }: { id: string }) {
    const [paid, setPaid] = useState<PaidReceipt | null>(null);
    const [error, setError] = useState<string | null>(null);
    // A second, public read: what the agent bought on the strength of this brief. It is deliberately
    // not part of the paid payload, so one route stays the single source of that claim everywhere.
    const backing = useBacking();

    useEffect(() => {
        // `get` retries a cold start; a 404 is an answer and is not retried
        get<PaidReceipt>(`/receipt/${id}`)
            .then(setPaid)
            .catch((e: unknown) => {
                setError(
                    e instanceof ApiError
                        ? e.message
                        : "Could not reach the agent. It may be restarting; try again shortly.",
                );
            });
    }, [id]);

    // the tab should not promise a brief the link does not open
    useEffect(() => {
        if (error !== null) document.title = "That link does not open a brief: Surplus";
    }, [error]);

    if (error !== null) {
        return (
            <Shell>
                <main id="main" className="shell grid min-h-[70vh] content-center py-16">
                    <div className="max-w-[46rem]">
                        <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.04em]">
                            That link does not open a brief.
                        </h1>
                        {/* The server's reason is its own sentence; run together with the next it reads as a fragment. */}
                        <p className="measure mt-5 text-[1.0625rem]">{error}</p>
                        <p className="measure mt-3 text-[1.0625rem]">
                            If you paid and lost your link, connect the wallet you paid with on the front page and the
                            agent will hand it back.
                        </p>
                        <div className="mt-8"><Button href="/#recover">Find my briefs <span aria-hidden="true">↗</span></Button></div>
                    </div>
                </main>
            </Shell>
        );
    }

    if (paid === null) {
        return (
            <Shell>
                <main id="main" className="shell grid min-h-[70vh] content-center py-16">
                    <p className="font-mono text-sm text-dim" role="status">Opening your brief…</p>
                </main>
            </Shell>
        );
    }

    const sources = new Map(paid.brief.sources.map((s) => [s.id, s]));
    const link = explorerTx(paid.receipt.network, paid.receipt.transaction);
    const chain = networkName(paid.receipt.network);
    const facts = paid.brief.themes.reduce((a, t) => a + t.claims.length, 0);
    const backed = forBrief(backing.k === "ready" ? backing.backing : null, paid.brief.id);

    return (
        <Shell>
            <main id="main">
                <section className="border-b border-line">
                    <div className="shell grid items-start gap-10 py-[clamp(2.5rem,5vw,3.5rem)] lg:grid-cols-[1fr_22rem]">
                        <motion.div variants={stagger()} initial="hidden" animate="shown">
                            <motion.p
                                variants={riseItem}
                                className="m-0 mb-5 inline-flex items-center gap-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-lime before:h-px before:w-6 before:bg-lime before:content-['']"
                            >
                                Paid · yours to keep
                            </motion.p>
                            <h1 className="text-[clamp(2.2rem,4.4vw,3.2rem)] font-medium leading-[1.02] tracking-[-0.045em]">
                                <MaskedLine delay={0.1}>Your brief.</MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                {count(paid.brief.themes.length, "theme")}, {count(facts, "verified fact")},{" "}
                                {count(paid.brief.sources.length, "filing")}. Every row below opens onto the filing
                                text behind it.
                            </motion.p>
                            <motion.p variants={riseItem} className="mt-4 font-mono text-xs text-dim">
                                Keep this link. It is the only way back, apart from the wallet you paid from.
                            </motion.p>
                        </motion.div>

                        <Reveal delay={0.15}>
                            <aside aria-label="Proof of purchase" className="rounded-card border border-line bg-surface p-5">
                                <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2.5 text-sm">
                                    <dt className="text-dim">Paid</dt>
                                    <dd className="num m-0 text-ink">{formatUsdc(paid.receipt.amountUsdcMinor)} USDC</dd>
                                    <dt className="text-dim">On</dt>
                                    <dd className="m-0 text-ink">{new Date(paid.receipt.at).toLocaleDateString()}</dd>
                                    <dt className="text-dim">Settlement</dt>
                                    <dd className="m-0 break-all font-mono text-ink">
                                        {link === null ? (
                                            <span title={paid.receipt.transaction}>{shortHash(paid.receipt.transaction)}</span>
                                        ) : (
                                            <a
                                                href={link.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={paid.receipt.transaction}
                                                className="text-ink no-underline [border-bottom:1px_solid_var(--color-line)] hover:[border-bottom-color:var(--color-lime)]"
                                            >
                                                {shortHash(paid.receipt.transaction)} <span aria-hidden="true">↗</span>
                                                <span className="sr-only"> (opens {link.name} in a new tab)</span>
                                            </a>
                                        )}
                                    </dd>
                                    <dt className="text-dim">Written by</dt>
                                    <dd className="m-0 text-ink">{paid.provider} {paid.model}</dd>
                                </dl>
                                {link === null && (
                                    // An old receipt predates the network being stored. Guessing it from this
                                    // server's chain could point at a transaction that is not theirs.
                                    <p className="mt-4 text-xs leading-relaxed text-dim">
                                        {chain === null
                                            ? "This purchase was recorded before the settlement network was stored, so there is no explorer link. The hash above is still the one onchain."
                                            : `Settled on ${chain}. No explorer is configured for it, so the hash is shown without a link.`}
                                    </p>
                                )}
                            </aside>
                        </Reveal>
                    </div>
                </section>

                <div className="shell grid items-start gap-10 py-[clamp(2.5rem,5vw,3.5rem)] lg:grid-cols-[1fr_17rem]">
                    <div className="min-w-0">
                        {paid.brief.themes.map((theme) => {
                            const claims = new Map(theme.claims.map((c) => [c.id, c]));
                            return (
                                <section key={theme.themeId} className="mb-12 last:mb-0">
                                    <Reveal>
                                        <div className="mb-4 flex items-baseline gap-3.5">
                                            <h2 className="text-xl font-semibold tracking-[-0.02em]">{theme.themeId}</h2>
                                            <span className="rounded-full border border-dashed border-line px-2.5 py-1 font-mono text-[0.6875rem] text-dim">
                                                {theme.gap ? "gap" : count(theme.fits.length, "company", "companies")}
                                            </span>
                                        </div>
                                    </Reveal>
                                    <ThemeStake brief={backed} themeId={theme.themeId} />
                                    {theme.gap ? (
                                        <p className="measure">
                                            {theme.gapReason ?? "No company cleared the evidence bar for this theme."}{" "}
                                            Nothing was invented to fill it.
                                        </p>
                                    ) : (
                                        <div className="border-t border-line">
                                            {theme.fits.map((fit, i) => {
                                                // The agent's own money on this company, in this theme. Absent for a
                                                // company it did not buy, which is most of them: a fit is research,
                                                // not an instruction, and the mandate caps every leg.
                                                const stake = assetStake(backed, theme.themeId, fit.symbol);
                                                return (
                                                    <EvidenceRow
                                                        key={fit.asset + fit.symbol}
                                                        fit={fit}
                                                        claims={claims}
                                                        sources={sources}
                                                        label={`fit ${fit.fit}/5`}
                                                        {...(stake !== null && { lead: formatUsdc(stake) })}
                                                        defaultOpen={i === 0}
                                                    />
                                                );
                                            })}
                                        </div>
                                    )}
                                </section>
                            );
                        })}
                    </div>

                    <aside aria-label="Filings and notes" className="grid gap-4 lg:sticky lg:top-24">
                        <div className="rounded-card border border-line bg-surface p-4">
                            <h3 className="mb-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-dim">
                                Filings read
                            </h3>
                            <ul className="m-0 grid list-none gap-2.5 p-0 font-mono text-xs">
                                {paid.brief.sources.map((s) => (
                                    <li key={s.id} className="grid gap-0.5">
                                        <SourceLink source={s} />
                                        <span className="text-[0.6875rem] text-dim">{s.publisher}</span>
                                    </li>
                                ))}
                                {paid.brief.sources.length === 0 && <li>No filings are listed in this brief.</li>}
                            </ul>
                        </div>
                        <div className="rounded-card border border-line bg-surface p-4">
                            <h3 className="mb-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-dim">
                                What a quote proves
                            </h3>
                            <WhatAQuoteProves />
                        </div>
                        {backed !== null && (
                            <div className="rounded-card border border-line bg-surface p-4">
                                <h3 className="mb-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-dim">
                                    Skin in the game
                                </h3>
                                <p className="m-0 mb-3 text-xs leading-relaxed text-dim">
                                    The agent {verb(backed.simulated)}{" "}
                                    <b className="num font-medium text-ink">{formatUsdc(backed.usdcMinor)} USDC</b> of
                                    the revenue this brief earned, in the companies it names. The amount against each
                                    company is in the right-hand column above.
                                </p>
                                <SimulatedNote brief={backed} />
                            </div>
                        )}
                    </aside>
                </div>
            </main>
            <Footer><span>{paid.brief.disclaimer}</span></Footer>
        </Shell>
    );
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <>
            <SiteHeader
                here="app"
                right={
                    <>
                        <Chip><Led />Base Sepolia</Chip>
                        <Button href="/app/library" tone="ghost" size="sm">Your library</Button>
                    </>
                }
            />
            {children}
        </>
    );
}
