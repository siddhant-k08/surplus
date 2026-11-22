import { useEffect, useRef, useState } from "react";
import { AnimatePresence, useInView, useReducedMotion } from "motion/react";
import { Reveal, motion } from "./motion";
import { Led, Spine } from "./Chrome";

/**
 * The storefront's middle: how a brief is built, what one looks like, and what the treasury does.
 *
 * Each section carries exactly one motion moment and each moment says something true. A line that
 * draws through four stages because the stages really are ordered. Claims that strike themselves out
 * because the agent really does drop them. A ledger that keeps arriving because it does.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

const STAGES = [
    { h: "Filings", p: "10-K and 10-Q documents straight from SEC EDGAR, never a summary." },
    { h: "Quotes", p: "A fact survives only if 20 to 300 characters appear verbatim in a filing it cites." },
    { h: "Fits", p: "A company reaches a theme only through a surviving fact from its own filing." },
    { h: "Gaps", p: "When nothing clears the bar, the theme comes back empty, with the reason." },
];

/** The four verdicts are real ones from the last run, including both ways a claim can fail. */
const PASS = [
    { sym: "TSLAc", txt: "Capital expenditure above $20 billion in 2026, driven by AI initiatives.", v: "kept" },
    { sym: "GOOGLc", txt: "AI accelerators including custom TPUs offered through Google Cloud.", v: "kept" },
    { sym: "AAPLc", txt: "Advertising language the model recalled from memory, not from the filing.", v: "not found" },
    { sym: "GOOGLc", txt: "A quote of 343 characters, past the limit a short excerpt allows.", v: "too long" },
] as const;

/**
 * A band of the page: its label on the left spine, its content on the right.
 *
 * The same two columns every time, so the page has one edge the eye returns to rather than a stack of
 * centred boxes. The label column is where the section names itself and, where it helps, counts itself.
 */
export function Band({
    id, label, aside, children,
}: {
    id: string; label: string; aside?: React.ReactNode; children: React.ReactNode;
}) {
    return (
        <section id={id} className="border-b border-line py-[clamp(3rem,6vw,4.5rem)]">
            <div className="shell band">
                <Spine label={label} aside={aside} />
                <div className="min-w-0">{children}</div>
            </div>
        </section>
    );
}

export function HowItWorks({ dropped }: { dropped: number }) {
    const pipe = useRef<HTMLDivElement>(null);
    const lit = useInView(pipe, { once: true, amount: 0.4 });
    const still = useReducedMotion() === true;

    return (
        <Band id="how" label="How a brief is built" aside="Four stages, in order. Nothing skips one.">
                <Reveal>
                    <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                        The agent is not asked to be right. It is asked to show its working.
                    </h2>
                    <p className="measure mt-4">
                        Each stage can only happen after the one above it, and anything that cannot clear a stage is
                        dropped rather than softened.
                    </p>
                </Reveal>

                {/* The line draws through the stages because the stages really are in that order. */}
                <div ref={pipe} className="relative mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    <span aria-hidden="true" className="absolute left-0 right-0 top-[11px] hidden h-px bg-line lg:block" />
                    <motion.span
                        aria-hidden="true"
                        className="absolute left-0 top-[11px] hidden h-px bg-lime shadow-[0_0_12px_rgba(218,250,156,0.5)] lg:block"
                        initial={still ? { width: "100%" } : { width: 0 }}
                        animate={lit ? { width: "100%" } : undefined}
                        transition={{ duration: 1.6, ease: EASE }}
                    />
                    {STAGES.map((s, i) => (
                        <div key={s.h} className="relative pt-9">
                            <motion.span
                                aria-hidden="true"
                                className="absolute left-0 top-1 grid size-[15px] place-items-center rounded-full border bg-soot"
                                initial={still ? false : { borderColor: "var(--color-line)" }}
                                animate={lit ? { borderColor: "var(--color-lime)" } : undefined}
                                transition={{ delay: 0.18 + i * 0.38, duration: 0.4 }}
                            >
                                <motion.span
                                    className="size-[5px] rounded-full"
                                    initial={still ? false : { backgroundColor: "var(--color-line)" }}
                                    animate={lit ? { backgroundColor: "var(--color-lime)" } : undefined}
                                    transition={{ delay: 0.18 + i * 0.38, duration: 0.4 }}
                                />
                            </motion.span>
                            <h3 className="text-base font-semibold">{s.h}</h3>
                            <p className="mt-1.5 text-sm">{s.p}</p>
                        </div>
                    ))}
                </div>

                <VerificationPass />

                <p className="measure mt-4 text-sm">
                    {dropped > 0
                        ? `${dropped} claims were dropped from the latest brief.`
                        : "Claims that cannot be quoted are dropped from every brief."}{" "}
                    The page says so, because an agent that hides its failures is not showing its working.
                </p>
        </Band>
    );
}

/** Two claims survive, two strike themselves out. The failures are the interesting half. */
function VerificationPass() {
    const ref = useRef<HTMLDivElement>(null);
    const run = useInView(ref, { once: true, amount: 0.4 });
    const still = useReducedMotion() === true;

    return (
        <div ref={ref} className="mt-10 overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.09em] text-dim">
                Verification pass · live sample
                <span className="ml-auto inline-flex items-center gap-1.5 text-lime"><Led />running</span>
            </div>
            {PASS.map((r, i) => {
                const cut = r.v !== "kept";
                const shown = still || run;
                return (
                    <div
                        key={`${r.sym}:${i}`}
                        className="grid grid-cols-[4.5rem_1fr] items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-b-0 sm:grid-cols-[5.5rem_1fr_7rem]"
                    >
                        <span className="font-mono text-[0.8125rem] text-ink">{r.sym}</span>
                        <motion.span
                            className={cut ? "text-faint line-through decoration-flag/60" : "text-dim"}
                            initial={still ? false : { opacity: 1, color: "var(--color-dim)" }}
                            animate={shown && cut ? { opacity: 0.7 } : { opacity: 1 }}
                            transition={{ delay: 0.35 + i * 0.42, duration: 0.5 }}
                        >
                            {r.txt}
                        </motion.span>
                        <motion.span
                            className={`col-start-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.06em] sm:col-start-3 sm:text-right ${
                                cut ? "text-flag" : "text-lime"
                            }`}
                            initial={still ? false : { opacity: 0 }}
                            animate={shown ? { opacity: 1 } : undefined}
                            transition={{ delay: 0.35 + i * 0.42, duration: 0.4 }}
                        >
                            {r.v}
                        </motion.span>
                    </div>
                );
            })}
        </div>
    );
}

/**
 * A sample of the thing being sold.
 *
 * Fixed sample content, not the live catalogue brief: a buyer's brief is what they paid for, and
 * serving its claims here for free would be selling the same thing twice. One row is open so the
 * shape is obvious without a click.
 */
const SAMPLE = [
    {
        sym: "TSLAc",
        what: "Tesla invests in compute infrastructure and data centers.",
        ev: "fit 3 · 1 quote",
        quote: "we currently expect our capital expenditures to be in excess of $20 billion in 2026, driven by our AI initiatives",
        cite: "Tesla, Inc. 10-K for period ending 2025-12-31, filed 2026-01-29",
    },
    {
        sym: "GOOGLc",
        what: "Alphabet offers AI accelerators including custom TPUs through Google Cloud.",
        ev: "fit 5 · 1 quote",
        quote: "AI-optimized infrastructure, including GPUs and custom-built TPUs, available through Google Cloud",
        cite: "Alphabet Inc. 10-K for period ending 2025-12-31, filed 2026-02-05",
    },
    {
        sym: "SNDKc",
        what: "Storage demand tied to AI training workloads.",
        ev: "fit 4 · 1 quote",
        quote: "demand for high-capacity storage driven by AI training and inference workloads",
        cite: "Sandisk Corp 10-Q for period ending 2026-10-02, filed 2026-10-30",
    },
    {
        sym: "longevity-biotech",
        what: "No company cleared the evidence bar. Returned as a gap.",
        ev: "gap",
        quote: null,
        cite: null,
    },
];

const FILINGS = [
    "TSLA 10-K 2026-01-29", "GOOGL 10-K 2026-02-05", "SNDK 10-Q 2026-10-30", "META 10-Q 2026-10-22",
    "MSFT 10-K 2026-07-29", "AAPL 10-K 2026-11-03", "AMZN 10-Q 2026-10-24", "NVDA 10-Q 2026-11-19",
    "SPCX 10-K 2026-03-11", "CRCL 10-Q 2026-08-07",
];

export function BriefPreview() {
    return (
        <Band id="brief" label="What you get" aside="A fixed sample. The brief you buy carries its own.">
                <Reveal>
                    <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                        A brief you can take apart.
                    </h2>
                    <p className="measure mt-4">
                        Open any row. Every claim the agent used is there, with every quote under it and a link to the
                        filing it came from. This is a fixed sample; the brief you buy carries its own.
                    </p>
                </Reveal>

                <div className="mt-8 border-t border-line">
                    {SAMPLE.map((row, i) => (
                        <SampleRow key={row.sym} {...row} defaultOpen={i === 0} />
                    ))}
                </div>

                <Marquee />
        </Band>
    );
}

function SampleRow({
    sym, what, ev, quote, cite, defaultOpen,
}: {
    sym: string; what: string; ev: string; quote: string | null; cite: string | null; defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen === true);
    const still = useReducedMotion() === true;
    return (
        <div className="border-b border-line">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="group relative flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-0 bg-transparent py-4 text-left"
            >
                <span
                    aria-hidden="true"
                    className={`absolute -left-4 top-0 h-full w-0.5 origin-top bg-lime transition-transform duration-300 ${
                        open ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"
                    }`}
                />
                <span className="min-w-[5rem] font-mono text-sm text-ink">{sym}</span>
                <span className="flex-1 text-[0.9375rem] text-dim">{what}</span>
                <span className="rounded-full border border-line px-2.5 py-1 font-mono text-[0.6875rem] text-dim">{ev}</span>
                <motion.span
                    aria-hidden="true"
                    className="text-xs text-dim"
                    animate={{ rotate: open ? 180 : 0, color: open ? "var(--color-lime)" : "var(--color-dim)" }}
                    transition={{ duration: 0.3, ease: EASE }}
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
                        transition={{ duration: 0.4, ease: EASE }}
                        className="grid"
                    >
                        <div className="overflow-hidden">
                            <div className="pb-5">
                                {quote === null ? (
                                    <p className="m-0 max-w-[62ch] text-[0.9375rem] text-dim">
                                        Nothing was invented to fill it. An empty answer is more useful than a confident
                                        one with nothing behind it.
                                    </p>
                                ) : (
                                    <>
                                        <blockquote className="m-0 max-w-[68ch] border-l-2 border-lime pl-3.5 font-mono text-[0.8125rem] leading-[1.7] text-dim">
                                            “{quote}”
                                        </blockquote>
                                        <p className="mt-2.5 pl-3.5 font-mono text-xs text-dim">
                                            <span className="text-ink">{cite}</span> · SEC EDGAR
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/** The documents actually read, drifting past. Pauses on hover so one can be read. */
function Marquee() {
    const still = useReducedMotion() === true;
    if (still) {
        return (
            <p className="mt-10 border-y border-line py-3.5 font-mono text-[0.8125rem] text-dim">
                Filings read: {FILINGS.join(" · ")}
            </p>
        );
    }
    return (
        <div className="group mt-10 overflow-hidden border-y border-line py-3.5 [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
            <div className="flex w-max gap-10 font-mono text-[0.8125rem] text-dim [animation:surplus-marquee_38s_linear_infinite] group-hover:[animation-play-state:paused]">
                {[...FILINGS, ...FILINGS].map((f, i) => {
                    const [ticker, ...rest] = f.split(" ");
                    return (
                        <span key={`${f}:${i}`} className="whitespace-nowrap">
                            <b className="font-medium text-ink">{ticker}</b> {rest.join(" ")}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

const RAIL = [
    ["Sync revenue and costs", "reads the books"],
    ["Request a proposal", "quotes live"],
    ["Review the evidence", "every claim"],
    ["Sign the payload", "EIP-712"],
    ["Execute", "simulated"],
] as const;

const ARRIVALS = [
    ["PAYMENT", "brief-2026-11-21 · 0x7a3f…11ce", "+0.010000"],
    ["PAYMENT", "brief-2026-11-21 · 0x9b20…4dd1", "+0.010000"],
    ["RESERVE", "topup · target 0.500000", "+0.010000"],
    ["REFUSAL", "below_minimum · 0.012 < 0.050", "0.000000"],
] as const;

type Row = { id: number; a: string; b: string; c: string };

export function TreasuryStrip() {
    const still = useReducedMotion() === true;
    const ref = useRef<HTMLDivElement>(null);
    const live = useInView(ref, { amount: 0.3 });
    const [rows, setRows] = useState<Row[]>([
        { id: 0, a: "PAYMENT", b: "brief-2026-11-21 · 0xcd71…bd93", c: "+0.010000" },
        { id: 1, a: "COST", b: "llm · gemini-3.1-flash-lite", c: "-0.021201" },
        { id: 2, a: "RESERVE", b: "topup · target 0.500000", c: "+0.030000" },
    ]);

    // The book really does keep growing, so the panel does too. Only while it is on screen: a timer
    // ticking against a section nobody is looking at is just battery.
    useEffect(() => {
        if (still || !live) return;
        let n = 0;
        const h = setInterval(() => {
            const [a, b, c] = ARRIVALS[n % ARRIVALS.length]!;
            n += 1;
            setRows((prev) => [{ id: Date.now(), a, b, c }, ...prev].slice(0, 5));
        }, 4200);
        return () => clearInterval(h);
    }, [still, live]);

    return (
        <Band id="treasury" label="Treasury" aside="What the agent does with what it earns.">
                <Reveal>
                    <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                        Nothing moves until you sign.
                    </h2>
                    <p className="measure mt-4">
                        The agent proposes. You read the evidence, sign the exact payload, and only then does it
                        execute. If the price drifts while you think, your signature stops being valid.
                    </p>
                </Reveal>

                <div className="mt-9 grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr]">
                    <div className="grid gap-0.5">
                        {RAIL.map(([label, hint], i) => (
                            <Reveal key={label} delay={i * 0.07}>
                                <div className="flex items-center gap-3.5 rounded-[5px] border border-transparent px-3.5 py-2.5 text-[0.9375rem]">
                                    <span className="grid size-6 shrink-0 place-items-center rounded-[4px] bg-pill font-mono text-[0.6875rem] font-medium text-dim">
                                        {i + 1}
                                    </span>
                                    <span>{label}</span>
                                    <span className="ml-auto font-mono text-[0.6875rem] text-dim">{hint}</span>
                                </div>
                            </Reveal>
                        ))}
                    </div>

                    <div>
                        <div ref={ref} className="overflow-hidden rounded-card border border-line bg-surface">
                            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.09em] text-dim">
                                Ledger · append only
                                <span className="ml-auto inline-flex items-center gap-1.5 text-lime"><Led />live</span>
                            </div>
                            <AnimatePresence initial={false}>
                                {rows.map((r) => (
                                    <motion.div
                                        key={r.id}
                                        layout={!still}
                                        initial={still ? false : { opacity: 0, y: -8, backgroundColor: "rgba(218,250,156,0.08)" }}
                                        animate={{ opacity: 1, y: 0, backgroundColor: "rgba(218,250,156,0)" }}
                                        transition={{ duration: 0.6, ease: EASE }}
                                        className="grid grid-cols-[5.5rem_1fr_auto] gap-3 border-b border-line px-4 py-2.5 font-mono text-xs leading-relaxed last:border-b-0"
                                    >
                                        <b className="font-medium text-ink">{r.a}</b>
                                        <span className="truncate">{r.b}</span>
                                        <span className="text-ink">{r.c}</span>
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </div>
                        <div className="mt-5 flex flex-wrap gap-2">
                            <Badge tone="ok">Books reconciled</Badge>
                            <Badge>Fills simulated</Badge>
                            <Badge tone="warn">Mainnet off</Badge>
                        </div>
                    </div>
                </div>
        </Band>
    );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "ok" | "warn" }) {
    const colour = tone === "ok" ? "text-lime" : tone === "warn" ? "text-amber" : "text-dim";
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-[3px] bg-pill px-2.5 py-2 font-mono text-[0.625rem] font-medium uppercase tracking-[0.09em] ${colour}`}>
            <span className="size-[5px] rounded-full bg-current" />
            {children}
        </span>
    );
}
