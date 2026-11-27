import { useEffect, useRef, useState } from "react";
import { Button, Chip, Footer, Led, Note, SiteHeader, Spine } from "./Chrome";
import { ConnectRow, WalletChip, useWallet } from "./Connect";
import { isOwnerWallet, useOwnerSignedIn } from "./session";
import { MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { formatUsdc, get } from "./api";
import { networkName } from "./explorer";
import { chainIdFromCaip, describeWalletError, ensureChain, readUsdcBalance } from "./wallet";

interface Catalogue {
    briefPriceUsd: string;
    researchPriceUsd: string;
    network: string;
    asset: string;
    payTo: string;
    /** Public, so the page can tell the owner from a buyer. Not a credential: see the catalogue route. */
    ownerAddress: string;
    salesBooked: number;
    revenueUsdcMinor: string;
    maxThemes: number;
    latest: { id: string; createdAt: string; themes: string[]; sources: number; facts: number } | null;
}

type Bought = { receipt: { id: string; url: string } };
type Load = { state: "loading" } | { state: "ready"; cat: Catalogue } | { state: "down"; why: string };

/**
 * The app: the two things that are for sale, and a wallet to pay with.
 *
 * Everything that explains the agent lives on the landing page now. What is left here is the part
 * that moves money, so the page is laid out as a counter rather than a pitch: connect, choose, pay,
 * get a link. The payment stack is imported only when someone decides to buy, so opening the app
 * still costs nothing.
 */
export function AppHome() {
    const [load, setLoad] = useState<Load>({ state: "loading" });
    const [themes, setThemes] = useState("");
    const [busy, setBusy] = useState<null | "brief" | "research">(null);
    const [error, setError] = useState<string | null>(null);
    const [bought, setBought] = useState<Bought | null>(null);
    const [balance, setBalance] = useState<string | null>(null);
    const form = useRef<HTMLTextAreaElement | null>(null);
    const wallet = useWallet();

    useEffect(() => {
        get<Catalogue>("/catalogue")
            .then((cat) => setLoad({ state: "ready", cat }))
            .catch(() =>
                setLoad({ state: "down", why: "Could not reach the agent. It may be restarting; try again shortly." }),
            );
    }, []);

    const cat = load.state === "ready" ? load.cat : null;

    // What the wallet can actually spend, read through the wallet's own provider. A failure is a
    // missing number and never an error on screen: the purchase works without it.
    useEffect(() => {
        if (wallet.address === null || cat === null) return;
        let live = true;
        void readUsdcBalance(wallet.address, cat.asset)
            .then((b) => { if (live) setBalance(b); })
            .catch(() => { if (live) setBalance(null); });
        return () => { live = false; };
    }, [wallet.address, cat]);

    async function purchase(kind: "brief" | "research") {
        // the catalogue says which chain is being paid on, and nothing is signed on a guess
        if (wallet.address === null || cat === null) return;
        setBusy(kind);
        setError(null);
        setBought(null);
        try {
            // before anything is signed: a wallet on the wrong chain fails in a way nobody can read
            const network = cat.network;
            const wanted = chainIdFromCaip(network);
            if (wanted !== null) await ensureChain(wanted);
            const { buy } = await import("./buy"); // the payment stack, only now
            const result = await buy({
                path: kind === "brief" ? "/brief" : "/research",
                address: wallet.address,
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
    const chain = networkName(cat?.network) ?? "Base";
    const connected = wallet.address !== null;
    /*
     * Shown to the owner and to nobody else: for a buyer it is a door they cannot open, and a hint
     * that the page they are on is not really for them.
     *
     * Either test is enough. A live session is the certain one, but it is also circular, because the
     * only way to start a session is the page this button leads to. Recognising the owner's own
     * connected wallet breaks that loop: connecting, which the owner does anyway, is what makes the
     * door appear.
     */
    const ownerHere = useOwnerSignedIn() || isOwnerWallet(wallet.address, cat?.ownerAddress);

    return (
        <>
            <SiteHeader
                here="app"
                right={
                    <>
                        <Chip><Led />{chain}</Chip>
                        <WalletChip wallet={wallet} />
                        {ownerHere && <Button href="/desk" tone="ghost" size="sm">Owner desk</Button>}
                    </>
                }
            />

            <main id="main">
                <section className="border-b border-line">
                    <div className="shell grid items-start gap-10 pt-[clamp(2.25rem,5vw,3.25rem)] pb-[clamp(2.25rem,5vw,3.25rem)] lg:grid-cols-[1.1fr_0.9fr]">
                        <motion.div variants={stagger()} initial="hidden" animate="shown">
                            <motion.p
                                variants={riseItem}
                                className="m-0 mb-4 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-dim"
                            >
                                Buy a brief
                            </motion.p>
                            <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                <MaskedLine delay={0.1}>Pay in USDC. Keep the link.</MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                One signature in your wallet settles the payment and the brief opens straight after. No
                                account, no email: the link and the wallet that paid are both ways back in.
                            </motion.p>

                            <motion.div variants={riseItem} className="mt-7">
                                <ConnectRow wallet={wallet} chain={chain} />
                            </motion.div>

                            <motion.div variants={riseItem} className="mt-7 flex flex-wrap gap-3">
                                <Button
                                    onClick={() => void purchase("brief")}
                                    disabled={busy !== null || !connected || soldOut || load.state !== "ready"}
                                    title={connected ? undefined : "Connect a wallet first"}
                                >
                                    {busy === "brief" ? "Waiting for your wallet…" : `Buy the latest brief · ${price}`}
                                    <span aria-hidden="true">↗</span>
                                </Button>
                                <Button tone="ghost" onClick={toForm} disabled={load.state === "down"}>
                                    Commission your themes <span aria-hidden="true">↓</span>
                                </Button>
                            </motion.div>

                            {/* One place for the outcome of a purchase, so it is never two states at once. */}
                            <div className="mt-5 grid gap-2" aria-live="polite">
                                {load.state === "down" && <Note tone="bad" alert>{load.why}</Note>}
                                {soldOut && load.state === "ready" && (
                                    <Note>
                                        There is no brief in the catalogue at this moment. You can still commission your
                                        own themes below.
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
                                        Paid.{" "}
                                        <a className="text-ink underline underline-offset-2" href={bought.receipt.url}>
                                            Open your brief
                                        </a>
                                        . Keep that link: it is the way back in, and the wallet you paid from is the
                                        other. Everything you own is in your{" "}
                                        <a className="text-ink underline underline-offset-2" href="/app/library">library</a>.
                                    </Note>
                                )}
                            </div>
                        </motion.div>

                        <motion.div variants={stagger(0.09, 0.35)} initial="hidden" animate="shown">
                            <motion.div variants={riseItem}>
                                <Counter
                                    chain={chain}
                                    price={price}
                                    custom={custom}
                                    balance={balance}
                                    connected={connected}
                                    latest={cat?.latest ?? null}
                                    loading={load.state === "loading"}
                                />
                            </motion.div>
                        </motion.div>
                    </div>
                </section>

                <section id="commission" className="border-b border-line py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine label="Made to order" aside={`Up to ${cat?.maxThemes ?? 3} themes, researched on request.`} />
                        <div className="min-w-0">
                            <Reveal>
                                <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                                    Commission your own themes.
                                </h2>
                                <p className="measure mt-4">
                                    Send up to {cat?.maxThemes ?? 3} themes and the agent researches them against the
                                    same filings under the same rules, for {custom} in USDC. If a theme turns up nothing
                                    that can be quoted, you get the gap and the reason rather than filler.
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
                                        disabled={busy !== null || !connected || parsed.length === 0}
                                        title={connected ? undefined : "Connect a wallet first"}
                                    >
                                        {busy === "research" ? "Researching, this takes a minute…" : `Commission it · ${custom}`}
                                        <span aria-hidden="true">↗</span>
                                    </Button>
                                </div>
                            </Reveal>
                        </div>
                    </div>
                </section>

                <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine label="Lost your link?" aside="The wallet that paid is the other way in." />
                        <div className="min-w-0">
                            <Reveal>
                                <h2 className="text-[clamp(1.5rem,2.6vw,2rem)] font-medium leading-[1.12] tracking-[-0.035em]">
                                    Your wallet is the account.
                                </h2>
                                <p className="measure mt-4">
                                    A receipt link is shown once, when you pay. If you lost it, nothing is gone: sign
                                    with the wallet you paid from and the agent hands back every brief it bought. That
                                    is what your library is.
                                </p>
                                <div className="mt-6">
                                    <Button href="/app/library" tone="ghost">
                                        Open your library <span aria-hidden="true">↗</span>
                                    </Button>
                                </div>
                            </Reveal>
                        </div>
                    </div>
                </section>
            </main>

            <Footer>
                <span>USDC on {chain}</span>
                <span>Paid to {cat?.payTo ?? "the operator"}</span>
                <span>Research is informational and is not investment advice.</span>
            </Footer>
        </>
    );
}

/**
 * What the counter would tell you before you paid: the network, the two prices, what is on offer,
 * and what your wallet holds. Every row is a fact about this purchase, not a feature.
 */
function Counter({
    chain, price, custom, balance, connected, latest, loading,
}: {
    chain: string;
    price: string;
    custom: string;
    balance: string | null;
    connected: boolean;
    latest: { themes: string[]; facts: number; sources: number } | null;
    loading: boolean;
}) {
    const rows: [string, string][] = [
        ["Network", chain],
        ["Latest brief", price],
        ["Your themes", custom],
        ["Your USDC", connected ? (balance ?? "could not read") : "connect to read"],
    ];
    return (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.09em] text-dim">
                This purchase
                <span className="ml-auto inline-flex items-center gap-1.5 text-lime"><Led />settles onchain</span>
            </div>
            <dl className="m-0 grid">
                {rows.map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-3">
                        <dt className="text-[0.8125rem] text-dim">{k}</dt>
                        <dd className="num m-0 font-mono text-[0.8125rem] text-ink">{v}</dd>
                    </div>
                ))}
            </dl>
            <div className="px-4 py-3.5 font-mono text-[0.6875rem] leading-relaxed text-dim">
                {loading
                    ? "Reading the catalogue…"
                    : latest === null
                        ? "No brief in the catalogue right now."
                        : `On offer: ${latest.themes.join(" · ")} · ${latest.facts} verified facts · ${latest.sources} filings`}
            </div>
        </div>
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
