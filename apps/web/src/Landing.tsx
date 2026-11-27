import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Button, Chip, Figures, Footer, Led, OpenApp, SiteHeader } from "./Chrome";
import { Band, BriefPreview, HowItWorks, TreasuryStrip } from "./Sections";
import { BackingBand } from "./Backing";
import { MaskedLine, Reveal, motion, riseItem, stagger, useSpotlight } from "./motion";
import { formatUsdc, get } from "./api";
import { networkName } from "./explorer";

interface Catalogue {
    briefPriceUsd: string;
    researchPriceUsd: string;
    network: string;
    payTo: string;
    salesBooked: number;
    revenueUsdcMinor: string;
    maxThemes: number;
    latest: { id: string; createdAt: string; themes: string[]; sources: number; facts: number } | null;
}

/**
 * The page a stranger lands on.
 *
 * It sells nothing by itself: no wallet is woken, no payment stack is loaded, nothing on it can take
 * money. Its whole job is to say what the agent does and show enough of the real thing to be
 * believed, then hand over to the app through one button. Reading about a product and using it are
 * different states of mind, and a page that tries to be both ends up being neither.
 */
export function Landing() {
    const [cat, setCat] = useState<Catalogue | null>(null);
    const [down, setDown] = useState(false);
    const hero = useSpotlight<HTMLElement>();

    useEffect(() => {
        get<Catalogue>("/catalogue").then(setCat).catch(() => setDown(true));
    }, []);

    const chain = networkName(cat?.network) ?? "Base";
    const price = cat?.briefPriceUsd ?? "—";
    const custom = cat?.researchPriceUsd ?? "—";

    return (
        <>
            <SiteHeader
                here="home"
                right={
                    <>
                        <Chip><Led />{chain}</Chip>
                        <OpenApp />
                    </>
                }
            />

            <main id="main">
                <section
                    ref={hero}
                    className="relative overflow-hidden before:pointer-events-none before:absolute before:inset-0 before:z-0 before:bg-[radial-gradient(28rem_20rem_at_var(--mx,30%)_var(--my,25%),rgba(218,250,156,0.07),transparent_70%)] before:opacity-[var(--spot,0)] before:transition-opacity before:duration-500"
                >
                    <div className="shell relative z-10 grid items-start gap-12 pt-[clamp(3rem,7vw,5rem)] pb-[clamp(2.5rem,5vw,3.5rem)] lg:grid-cols-[1.08fr_0.92fr]">
                        <motion.div variants={stagger()} initial="hidden" animate="shown">
                            <motion.p
                                variants={riseItem}
                                className="m-0 mb-5 inline-flex items-center gap-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-lime before:h-px before:w-6 before:bg-lime before:content-['']"
                            >
                                Autonomous research agent
                            </motion.p>
                            <h1 className="text-[clamp(2.4rem,5.4vw,4.1rem)] font-medium leading-[1.0] tracking-[-0.045em]">
                                <MaskedLine delay={0.12}>It only sells</MaskedLine>
                                <MaskedLine delay={0.23}>
                                    what it <Underline>can prove</Underline>.
                                </MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="mt-6 max-w-[44ch] text-[1.0625rem]">
                                Filings in, quoted facts out, anything unquotable dropped before you see it. The agent
                                books its own costs, fills a reserve, and asks before investing a cent of what is left.
                            </motion.p>
                            <motion.div variants={riseItem} className="mt-8 flex flex-wrap gap-3">
                                <Button href="/app" size="md">
                                    Open app <span aria-hidden="true">↗</span>
                                </Button>
                                <Button href="/filings" tone="ghost" size="md">
                                    See what it has read
                                </Button>
                            </motion.div>
                            <motion.p variants={riseItem} className="mt-5 font-mono text-xs text-dim">
                                {down
                                    ? "The agent is unreachable right now. The pages below still describe how it works."
                                    : `A brief costs ${price} in USDC. Your own themes, researched on request, ${custom}.`}
                            </motion.p>
                        </motion.div>

                        <motion.div variants={stagger(0.09, 0.45)} initial="hidden" animate="shown">
                            <motion.div variants={riseItem}>
                                <ProofPanel latest={cat?.latest ?? null} loading={cat === null && !down} />
                            </motion.div>
                        </motion.div>
                    </div>
                </section>

                <Figures
                    cells={[
                        { k: "Briefs sold", v: String(cat?.salesBooked ?? 0) },
                        { k: "Revenue", v: formatUsdc(cat?.revenueUsdcMinor ?? "0"), unit: "USDC" },
                        { k: "Filings read", v: String(cat?.latest?.sources ?? 0) },
                        { k: "Themes", v: String(cat?.latest?.themes.length ?? 0), unit: "in the latest brief" },
                    ]}
                />

                <HowItWorks dropped={0} />

                <BriefPreview />

                <TreasuryStrip />

                {/* The treasury band is the control; this is the result. Real numbers, from a public route. */}
                <BackingBand />

                <Band
                    id="what-you-can-buy"
                    label="What is for sale"
                    aside={`Both paid in USDC on ${chain}.`}
                >
                    <Reveal>
                        <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                            Two things, one standard of proof.
                        </h2>
                        <p className="measure mt-4">
                            The brief that already exists can tell you exactly what is in it before you pay. The one
                            you commission cannot, so it is held to the same rules instead: quoted or dropped, and a
                            theme that turns up nothing comes back as a gap with the reason.
                        </p>
                    </Reveal>

                    <div className="mt-9 grid gap-px border border-line bg-line sm:grid-cols-2">
                        <Offer
                            title="The latest brief"
                            price={price}
                            lines={[
                                cat?.latest === null
                                    ? "Nothing on offer at this moment."
                                    : `${cat?.latest?.themes.length ?? 0} themes, ${cat?.latest?.facts ?? 0} verified facts`,
                                "Delivered the moment the payment settles",
                                "A private link, recoverable by the wallet that paid",
                            ]}
                        />
                        <Offer
                            title="Your own themes"
                            price={custom}
                            lines={[
                                `Up to ${cat?.maxThemes ?? 3} themes, researched on request`,
                                "Same filings, same verification, same gaps",
                                "Takes about a minute while you wait",
                            ]}
                        />
                    </div>

                    <Reveal delay={0.08}>
                        <div className="mt-8 flex flex-wrap items-center gap-4">
                            <OpenApp size="md" />
                            <span className="font-mono text-xs text-dim">
                                Nothing is charged until you sign in your own wallet.
                            </span>
                        </div>
                    </Reveal>
                </Band>
            </main>

            <Footer>
                <span>USDC on {chain}</span>
                <span>Paid to {cat?.payTo ?? "the operator"}</span>
                <span>Research is informational and is not investment advice. Filing text is quoted from SEC EDGAR.</span>
            </Footer>
        </>
    );
}

function Offer({ title, price, lines }: { title: string; price: string; lines: string[] }) {
    return (
        <div className="bg-soot p-6">
            <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-[1.0625rem] font-semibold">{title}</h3>
                <span className="num font-mono text-sm text-lime">{price}</span>
            </div>
            <ul className="m-0 mt-4 grid list-none gap-2 p-0 text-[0.9375rem]">
                {lines.map((l) => (
                    <li key={l} className="grid grid-cols-[0.9rem_1fr] gap-2.5">
                        <span aria-hidden="true" className="mt-[0.55em] h-px bg-lime" />
                        <span>{l}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The underline draws itself under the promise, once the headline has landed. */
function Underline({ children }: { children: React.ReactNode }) {
    const still = useReducedMotion() === true;
    return (
        <span className="relative whitespace-nowrap">
            {children}
            <motion.span
                aria-hidden="true"
                className="absolute bottom-[0.06em] left-0 h-[0.09em] bg-lime"
                initial={still ? { width: "100%" } : { width: 0 }}
                animate={{ width: "100%" }}
                transition={{ duration: 0.7, delay: 0.95, ease: [0.22, 1, 0.36, 1] }}
            />
        </span>
    );
}

/**
 * The hero's right half: one real piece of evidence, with the chain it hangs on.
 *
 * It is the product in miniature. A claim, the sentence from the filing that carries it, and the
 * path from one to the other, lit link by link so the order is unmistakable. Fixed sample content,
 * not the brief on offer: serving a buyer's claims here for free would be selling them twice.
 */
function ProofPanel({
    latest,
    loading,
}: {
    latest: { themes: string[]; facts: number; sources: number } | null;
    loading: boolean;
}) {
    const still = useReducedMotion() === true;
    const links = ["claim", "quote", "10-K", "EDGAR ↗"];
    return (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.09em] text-dim">
                Evidence · TSLAc · ai-compute
                <span className="ml-auto inline-flex items-center gap-1.5 text-lime"><Led />verified</span>
            </div>
            <div className="p-4">
                <p className="m-0 text-[0.9375rem] leading-6 text-ink">
                    Tesla invests in compute infrastructure and data centers as part of its AI initiatives.
                </p>
                <motion.blockquote
                    className="mt-3.5 border-l-2 border-lime pl-3.5 font-mono text-[0.8125rem] leading-[1.65] text-dim"
                    initial={still ? false : { clipPath: "inset(0 100% 0 0)" }}
                    animate={{ clipPath: "inset(0 0 0 0)" }}
                    transition={{ duration: 1.1, delay: 0.75, ease: [0.33, 1, 0.68, 1] }}
                >
                    “we currently expect our capital expenditures to be in excess of $20 billion in 2026, driven by our
                    AI initiatives, including investments in compute infrastructure and data centers”
                </motion.blockquote>
                <div className="mt-4 flex flex-wrap items-center gap-1.5 font-mono text-[0.6875rem] font-medium">
                    {links.map((l, i) => (
                        <span key={l} className="contents">
                            {i > 0 && (
                                <motion.span
                                    className="text-lime"
                                    initial={still ? false : { opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: 1.75 + i * 0.26 }}
                                >
                                    →
                                </motion.span>
                            )}
                            <motion.span
                                className={`rounded-[3px] px-2 py-1.5 ${
                                    i === links.length - 1 ? "bg-lime text-lime-ink" : "bg-pill text-ink"
                                }`}
                                initial={still ? false : { opacity: 0.3, y: 3 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 1.65 + i * 0.26, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                            >
                                {l}
                            </motion.span>
                        </span>
                    ))}
                </div>
                <p className="mt-4 font-mono text-[0.6875rem] text-dim">
                    {loading
                        ? "Reading the catalogue…"
                        : latest === null
                            ? "No brief on offer right now."
                            : `On offer: ${latest.themes.join(" · ")} · ${latest.facts} verified facts · ${latest.sources} filings`}
                </p>
            </div>
        </div>
    );
}
