import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Recover } from "./Recover";
import { Button, Chip, Footer, Led, NavLink, TopBar } from "./Chrome";
import { CountUp, MaskedLine, Reveal, riseItem, stagger, useSpotlight , motion } from "./motion";
import { Band, HowItWorks, BriefPreview, TreasuryStrip } from "./Sections";
import { formatUsdc, get } from "./api";
import { networkName } from "./explorer";
import { connect, hasWallet, describeWalletError, ensureChain, chainIdFromCaip } from "./wallet";

interface Catalogue {
    briefPriceUsd: string;
    researchPriceUsd: string;
    network: string;
    asset: string;
    payTo: string;
    salesBooked: number;
    revenueUsdcMinor: string;
    maxThemes: number;
    latest: { id: string; createdAt: string; themes: string[]; sources: number; facts: number } | null;
}

type Bought = { receipt: { id: string; url: string } };
type Load = { state: "loading" } | { state: "ready"; cat: Catalogue } | { state: "down"; why: string };

/**
 * The public face: the two things that are for sale, and a wallet to pay with.
 *
 * Both paths lead to a paid brief, so neither is a footnote. One sells a brief that already exists and
 * can say exactly what is in it; the other sells research that does not exist yet and can only promise
 * the rules it will be held to. Equal weight, different substance.
 *
 * The payment stack is imported only when someone decides to buy, so reading the page costs nothing.
 */
export function Store() {
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [themes, setThemes] = useState("");
    const [busy, setBusy] = useState<null | "brief" | "research">(null);
    const [error, setError] = useState<string | null>(null);
    const [bought, setBought] = useState<Bought | null>(null);
    const form = useRef<HTMLTextAreaElement | null>(null);
    const hero = useSpotlight<HTMLElement>();

    useEffect(() => {
        get<Catalogue>("/catalogue")
            .then((cat) => setLoad({ state: "ready", cat }))
            .catch(() =>
                setLoad({ state: "down", why: "Could not reach the agent. It may be restarting; try again shortly." }),
            );
    }, []);

    const cat = load.state === "ready" ? load.cat : null;

    async function purchase(kind: "brief" | "research") {
        setBusy(kind);
        setError(null);
        setBought(null);
        try {
            const address = await connect();
            // before anything is signed: a wallet on the wrong chain fails in a way nobody can read
            const network = cat?.network ?? "eip155:84532";
            const wanted = chainIdFromCaip(network);
            if (wanted !== null) await ensureChain(wanted);
            const { buy } = await import("./buy"); // the payment stack, only now
            const result = await buy({
                path: kind === "brief" ? "/brief" : "/research",
                address,
                network,
                ...(kind === "research" && { body: { themes: parseThemes(themes) } }),
            });
            setBought({ receipt: result.receipt });
        } catch (e) {
            setError(describeWalletError(e));
        } finally {
            setBusy(null);
        }
    }

    function toForm() {
        document.getElementById("commission")?.scrollIntoView({ behavior: "smooth", block: "start" });
        form.current?.focus({ preventScroll: true });
    }

    const price = cat?.briefPriceUsd ?? "—";
    const custom = cat?.researchPriceUsd ?? "—";
    const parsed = parseThemes(themes);
    const soldOut = cat !== null && cat.latest === null;
    const chain = networkName(cat?.network) ?? "Base Sepolia";

    return (
        <>
            <TopBar
                nav={
                    <>
                        <NavLink href="#how">How it works</NavLink>
                        <NavLink href="#brief">The brief</NavLink>
                        <NavLink href="#treasury">Treasury</NavLink>
                        <NavLink href="#commission">Commission</NavLink>
                        <NavLink href="/library">My briefs</NavLink>
                    </>
                }
                right={
                    <>
                        <Chip title={cat?.network ?? ""}><Led />{chain}</Chip>
                        <Button href="/desk" tone="ghost" size="sm">Open desk</Button>
                    </>
                }
            />

            <main id="main">
                <section
                    ref={hero}
                    id="buy"
                    className="relative overflow-hidden before:pointer-events-none before:absolute before:inset-0 before:z-0 before:bg-[radial-gradient(28rem_20rem_at_var(--mx,30%)_var(--my,25%),rgba(218,250,156,0.07),transparent_70%)] before:opacity-[var(--spot,0)] before:transition-opacity before:duration-500"
                >
                    <div className="shell relative z-10 grid items-start gap-12 pt-[clamp(3rem,7vw,5rem)] pb-[clamp(2rem,4vw,3rem)] lg:grid-cols-[1.08fr_0.92fr]">
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
                            <motion.p variants={riseItem} className="mt-6 max-w-[42ch] text-[1.0625rem]">
                                Filings in, quoted facts out, anything unquotable dropped before you see it. The agent
                                books its own costs, fills a reserve, and asks before investing a cent of what is left.
                            </motion.p>
                            <motion.div variants={riseItem} className="mt-8 flex flex-wrap gap-3">
                                <Button
                                    onClick={() => void purchase("brief")}
                                    disabled={busy !== null || !hasWallet() || soldOut || load.state !== "ready"}
                                >
                                    {busy === "brief" ? "Waiting for your wallet…" : `Buy the latest brief · ${price}`}
                                    <span aria-hidden="true">↗</span>
                                </Button>
                                <Button tone="ghost" onClick={toForm} disabled={load.state === "down"}>
                                    Commission your themes <span aria-hidden="true">↓</span>
                                </Button>
                            </motion.div>
                        </motion.div>

                        <motion.div variants={stagger(0.09, 0.45)} initial="hidden" animate="shown">
                            <motion.div variants={riseItem}>
                                <ProofPanel cat={cat} loading={load.state === "loading"} />
                            </motion.div>
                        </motion.div>
                    </div>

                    {/* One place for the outcome of a purchase, so it is never two states at once. */}
                    <div className="shell relative z-10 grid gap-2 pb-[clamp(2rem,4vw,3rem)]" aria-live="polite">
                        {load.state === "down" && <Note tone="bad" alert>{load.why}</Note>}
                        {!hasWallet() && load.state !== "down" && (
                            <Note>
                                Buying needs a browser wallet holding USDC on {chain}. You do not need ETH: the
                                facilitator pays the gas.
                            </Note>
                        )}
                        {busy !== null && (
                            <Note>
                                {busy === "brief"
                                    ? "Confirm the payment in your wallet. Nothing is charged until you do."
                                    : "Confirm the payment, then the agent starts reading. Keep this tab open."}
                            </Note>
                        )}
                        {error !== null && <Note tone="bad" alert>{error}</Note>}
                        {bought !== null && (
                            <Note tone="good" status>
                                Paid. <a className="text-ink underline underline-offset-2" href={bought.receipt.url}>Open your brief</a>.
                                Keep that link: it is the way back in, and the wallet you paid from is the other.
                            </Note>
                        )}
                    </div>
                </section>

                <Stats cat={cat} />

                <HowItWorks dropped={0} />

                <BriefPreview />

                <TreasuryStrip />

                <Band id="commission" label="Made to order" aside={`Up to ${cat?.maxThemes ?? 3} themes, researched on request.`}>
                        <Reveal>
                            <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                                Commission your own themes.
                            </h2>
                            <p className="measure mt-4">
                                Send up to {cat?.maxThemes ?? 3} themes and the agent researches them against the same
                                filings under the same rules, for {custom} in USDC. If a theme turns up nothing that can
                                be quoted, you get the gap and the reason rather than filler.
                            </p>
                        </Reveal>
                        <Reveal delay={0.08}>
                            <label className="mt-7 block">
                                <span className="mb-2 block text-[0.8125rem] text-dim">
                                    One theme per line: a name, a colon, then a short description
                                </span>
                                <textarea
                                    ref={form}
                                    rows={4}
                                    value={themes}
                                    onChange={(e) => setThemes(e.target.value)}
                                    placeholder={"AI compute: data centre and accelerator demand\nLongevity biotech: therapies aimed at ageing"}
                                    className="w-full resize-y rounded-[6px] border border-line bg-soot px-3.5 py-3 text-[0.9375rem] leading-6 text-ink placeholder:text-faint"
                                />
                            </label>
                            <p className="mt-2 font-mono text-xs text-dim" aria-live="polite">
                                {parsed.length === 0
                                    ? "No themes yet. A line needs both a name and a description to count."
                                    : `${parsed.length} ready: ${parsed.map((t) => t.name).join(", ")}`}
                            </p>
                            <div className="mt-6">
                                <Button
                                    onClick={() => void purchase("research")}
                                    disabled={busy !== null || !hasWallet() || parsed.length === 0}
                                >
                                    {busy === "research" ? "Researching, this takes a minute…" : `Commission it · ${custom}`}
                                    <span aria-hidden="true">↗</span>
                                </Button>
                            </div>
                        </Reveal>
                </Band>

                <Band id="recover" label="Lost your link?" aside="The wallet that paid is the other way in.">
                    <Recover />
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
 * path from one to the other, lit link by link so the order is unmistakable.
 */
function ProofPanel({ cat, loading }: { cat: Catalogue | null; loading: boolean }) {
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
                        : cat?.latest === null || cat === null
                            ? "No brief on offer right now."
                            : `${cat.latest.themes.join(" · ")} · ${cat.latest.facts} verified facts · ${cat.latest.sources} filings`}
                </p>
            </div>
        </div>
    );
}

function Stats({ cat }: { cat: Catalogue | null }) {
    const cells = [
        { k: "Briefs sold", v: String(cat?.salesBooked ?? 0), unit: "" },
        { k: "Revenue", v: formatUsdc(cat?.revenueUsdcMinor ?? "0"), unit: "USDC" },
        { k: "Filings read", v: String(cat?.latest?.sources ?? 0), unit: "" },
        { k: "Themes", v: String(cat?.latest?.themes.length ?? 0), unit: "in the latest brief" },
    ];
    return (
        <div className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-4">
            {cells.map((c) => (
                <div key={c.k} className="group relative overflow-hidden border-b border-line px-[var(--gut)] py-5 last:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b-0">
                    <span className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.11em] text-dim">{c.k}</span>
                    <span className="mt-2.5 block font-mono text-[1.75rem] leading-none tracking-[-0.025em] text-ink">
                        <CountUp value={c.v} />
                        {c.unit !== "" && <small className="ml-1.5 text-[0.6875rem] font-normal tracking-normal text-dim">{c.unit}</small>}
                    </span>
                </div>
            ))}
        </div>
    );
}

function Note({
    children,
    tone = "plain",
    alert,
    status,
}: {
    children: React.ReactNode;
    tone?: "plain" | "good" | "bad";
    alert?: boolean;
    status?: boolean;
}) {
    const colour = tone === "bad" ? "text-flag" : tone === "good" ? "text-lime" : "text-dim";
    return (
        <p
            role={alert === true ? "alert" : status === true ? "status" : undefined}
            className={`measure m-0 text-sm ${colour}`}
        >
            {children}
        </p>
    );
}

/** "Name: description" per line. Anything without both halves is ignored rather than half-sent. */
export function parseThemes(raw: string): { name: string; description: string }[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
            const at = line.indexOf(":");
            if (at === -1) return null;
            const name = line.slice(0, at).trim();
            const description = line.slice(at + 1).trim();
            return name === "" || description === "" ? null : { name, description };
        })
        .filter((t): t is { name: string; description: string } => t !== null)
        .slice(0, 3);
}
