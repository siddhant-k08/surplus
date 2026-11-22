import { useState } from "react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { motion } from "./motion";
import type { BriefClaim, BriefFit, BriefSource } from "./api";

/**
 * The evidence behind one company in one theme, shown in full.
 *
 * The page this replaces rendered `claimIds[0]` and `quotes[0]`: one claim, one quote, and no sign that
 * there was more. For a product whose whole promise is that you can check it, silently dropping the rest
 * of the evidence is the worst possible thing to drop. Every claim a fit cites is rendered here, with
 * every quote under each, and each quote carries a link to the filing it came from.
 *
 * Disclosure is a `<details>`, so a long brief stays scannable, but the summary always says how much is
 * inside: progressive disclosure must never leave a reader unable to tell whether there is anything to
 * open.
 */

/** How much evidence a fit actually carries, for the summary line. Pure, so it can be tested. */
export function evidenceCount(
    fit: Pick<BriefFit, "claimIds">,
    claims: Map<string, BriefClaim>,
): { claims: number; quotes: number; missing: number } {
    let found = 0;
    let quotes = 0;
    let missing = 0;
    for (const id of fit.claimIds) {
        const claim = claims.get(id);
        if (claim === undefined) {
            missing += 1;
            continue;
        }
        found += 1;
        quotes += claim.quotes?.length ?? 0;
    }
    return { claims: found, quotes, missing };
}

/** Plural without the "(s)" that makes an interface read like a form letter. */
export function count(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** An outbound link to a filing. Never opens in place, never leaks the referrer. */
export function SourceLink({ source }: { source: BriefSource }) {
    const filed = source.publishedAt === null ? "" : `, filed ${source.publishedAt}`;
    if (source.url === "") return <span>{source.title}{filed}</span>;
    return (
        <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink no-underline decoration-line underline-offset-4 [border-bottom:1px_solid_var(--color-line)] hover:[border-bottom-color:var(--color-lime)]"
        >
            {source.title}{filed} <span aria-hidden="true">↗</span>
            <span className="sr-only"> (opens the filing in a new tab)</span>
        </a>
    );
}

export function EvidenceBody({
    fit,
    claims,
    sources,
}: {
    fit: BriefFit;
    claims: Map<string, BriefClaim>;
    sources: Map<string, BriefSource>;
}) {
    const cited = fit.claimIds.map((id) => ({ id, claim: claims.get(id) }));
    return (
        <div className="grid gap-5 pb-6">
            {cited.length === 0 && (
                <p className="m-0 text-[0.9375rem] text-dim">This fit cites no claim, so there is nothing to check.</p>
            )}
            {cited.map(({ id, claim }, i) => (
                <article key={id} className={`grid gap-3 ${i > 0 ? "border-t border-line/60 pt-5" : ""}`}>
                    {claim === undefined ? (
                        <p className="m-0 text-sm text-flag">
                            Claim {id} is cited by this fit but is not in the brief, so it cannot be checked here.
                        </p>
                    ) : (
                        <>
                            <p className="m-0 max-w-[62ch] text-[0.9375rem] leading-relaxed text-ink">{claim.text}</p>
                            {(claim.quotes ?? []).length === 0 ? (
                                <p className="m-0 text-sm text-dim">No quote was carried with this claim.</p>
                            ) : (
                                (claim.quotes ?? []).map((q, qi) => {
                                    const source = sources.get(q.sourceId);
                                    return (
                                        <figure key={`${id}:${qi}`} className="m-0">
                                            <blockquote className="m-0 max-w-[68ch] border-l-2 border-lime pl-3.5 font-mono text-[0.8125rem] leading-[1.7] text-dim">
                                                “{q.text}”
                                            </blockquote>
                                            <figcaption className="mt-2 pl-3.5 font-mono text-xs text-dim">
                                                {source === undefined
                                                    ? <span>source {q.sourceId} is not listed in this brief</span>
                                                    : <SourceLink source={source} />}
                                            </figcaption>
                                        </figure>
                                    );
                                })
                            )}
                        </>
                    )}
                </article>
            ))}
            <p className="m-0 font-mono text-xs text-dim">
                fit <b className="font-medium text-ink">{fit.fit}</b>/5 · evidence{" "}
                <b className="font-medium text-ink">{fit.evidence}</b>/5
            </p>
        </div>
    );
}

/**
 * One disclosure row.
 *
 * The height animates on grid rows rather than by measuring the content, so nothing has to be read
 * from the DOM and the row cannot disagree with itself mid-animation. The summary always says how
 * much is inside: progressive disclosure must never leave a reader unable to tell whether there is
 * anything to open.
 */
export function EvidenceRow({
    fit,
    claims,
    sources,
    label,
    lead,
    defaultOpen,
}: {
    fit: BriefFit;
    claims: Map<string, BriefClaim>;
    sources: Map<string, BriefSource>;
    label: string;
    lead?: string;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen === true);
    const still = useReducedMotion() === true;
    const c = evidenceCount(fit, claims);
    const has = c.claims > 0;

    return (
        <div className="border-b border-line">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="group relative flex w-full items-center gap-4 border-0 bg-transparent py-4 text-left text-inherit"
            >
                <span
                    aria-hidden="true"
                    className={`absolute -left-4 top-0 h-full w-0.5 origin-top bg-lime transition-transform duration-300 ease-[var(--ease-out-soft)] ${
                        open ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"
                    }`}
                />
                <span className="min-w-[5rem] font-mono text-sm text-ink">{fit.symbol}</span>
                <span className="flex-1 text-[0.9375rem] text-dim">{label}</span>
                <span
                    className={`whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[0.6875rem] ${
                        has ? "border border-line bg-pill text-dim" : "border border-dashed border-line text-faint"
                    }`}
                >
                    {has ? `${count(c.claims, "claim")}, ${count(c.quotes, "quote")}` : "no evidence"}
                </span>
                {lead !== undefined && <span className="num min-w-[7rem] text-right font-medium text-ink">{lead}</span>}
                <motion.span
                    aria-hidden="true"
                    className="text-xs text-dim"
                    animate={{ rotate: open ? 180 : 0, color: open ? "var(--color-lime)" : "var(--color-dim)" }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                    ▾
                </motion.span>
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={still ? false : { gridTemplateRows: "0fr", opacity: 0 }}
                        animate={{ gridTemplateRows: "1fr", opacity: 1 }}
                        exit={{ gridTemplateRows: "0fr", opacity: 0 }}
                        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                        className="grid"
                    >
                        <div className="overflow-hidden">
                            <EvidenceBody fit={fit} claims={claims} sources={sources} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/**
 * What a verbatim quote does and does not establish.
 *
 * Stated once per surface rather than next to every quote. The checks prove the sentence is in the
 * filing; whether it supports the claim around it is a judgement the reader makes, and a page that
 * implies otherwise is overselling the one thing this product is careful about.
 */
export function WhatAQuoteProves() {
    return (
        <p className="m-0 text-xs leading-relaxed text-dim">
            Each quote appeared verbatim in the filing it cites when the brief was built, and every number in a
            claim appeared in its own quotes. That shows the text is really there. It does not make the claim
            around it true, and none of this is investment advice.
        </p>
    );
}
