import { useEffect, useState } from "react";
import { formatUsdc, recoverReceipts, recoveryOffer, type RecoveredReceipt } from "./api";
import { connect, currentAccount, describeWalletError, hasWallet, readUsdcBalance, signTypedData } from "./wallet";
import { Button, Chip, Footer, Led, NavLink, TopBar } from "./Chrome";
import { CountUp, MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { explorerTx, networkName, shortHash } from "./explorer";

/**
 * Everything one wallet has bought, in one place.
 *
 * Recovery existed before this, but only as a rescue: a line on the storefront for someone who had
 * lost a link. That is the wrong shape for the thing a buyer comes back to. A wallet that has bought
 * four briefs has a library, a running total, and a balance it can spend on the next one.
 *
 * There is still no account and no email. The wallet signs once to prove it is theirs, and the agent
 * answers with what that wallet paid for. The signature authorises reading, nothing else.
 */

interface Terms {
    network: string;
    asset: string;
    briefPriceUsd: string;
}

type State =
    | { k: "idle" }
    | { k: "working" }
    | { k: "open"; address: string; receipts: RecoveredReceipt[] }
    | { k: "failed"; why: string };

export function Library({ terms }: { terms: Terms | null }) {
    const [state, setState] = useState<State>({ k: "idle" });
    const [balance, setBalance] = useState<string | null>(null);

    // If a wallet is already connected, say whose library this would be before anyone clicks.
    const [known, setKnown] = useState<string | null>(null);
    useEffect(() => { void currentAccount().then(setKnown); }, []);

    const address = state.k === "open" ? state.address : known;

    // What the wallet can actually spend. Read through the wallet's own provider rather than a public
    // RPC: it is already connected to the right chain, and the page gains no new host to trust.
    useEffect(() => {
        if (address === null || terms === null) return;
        let live = true;
        void readUsdcBalance(address, terms.asset)
            .then((b) => { if (live) setBalance(b); })
            .catch(() => { if (live) setBalance(null); });
        return () => { live = false; };
    }, [address, terms]);

    async function open() {
        setState({ k: "working" });
        try {
            const addr = await connect();
            const offer = await recoveryOffer(addr);
            const signature = await signTypedData(addr, offer);
            const result = await recoverReceipts({ address: addr, nonce: offer.message.nonce, signature });
            setState({ k: "open", address: result.address, receipts: result.receipts });
        } catch (e) {
            setState({ k: "failed", why: describeWalletError(e) });
        }
    }

    const chain = networkName(terms?.network) ?? "Base Sepolia";
    const receipts = state.k === "open" ? state.receipts : [];
    const spent = receipts.reduce((a, r) => a + BigInt(r.amountUsdcMinor), 0n);

    return (
        <>
            <TopBar
                nav={
                    <>
                        <NavLink href="/">Research</NavLink>
                        <NavLink href="/library" current>My briefs</NavLink>
                        <NavLink href="/desk">Treasury</NavLink>
                    </>
                }
                right={
                    <>
                        <Chip><Led />{chain}</Chip>
                        {address !== null && <Chip title={address}>{shortHash(address, 6, 4)}</Chip>}
                    </>
                }
            />

            <main id="main">
                <section className="border-b border-line">
                    <div className="shell band py-[clamp(2.5rem,5vw,3.5rem)]">
                        <div>
                            <Reveal>
                                <p className="m-0 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-dim">
                                    Your library
                                </p>
                            </Reveal>
                        </div>
                        <motion.div variants={stagger()} initial="hidden" animate="shown" className="min-w-0">
                            <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                <MaskedLine delay={0.1}>Everything this wallet bought.</MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                No account and no email. Sign once with the wallet that paid and the agent hands back
                                every brief it bought, with the settlement behind each one.
                            </motion.p>

                            {state.k !== "open" && (
                                <motion.div variants={riseItem} className="mt-8">
                                    <Button onClick={() => void open()} disabled={state.k === "working" || !hasWallet()}>
                                        {state.k === "working" ? "Check your wallet…" : "Open my library"}
                                        <span aria-hidden="true">↗</span>
                                    </Button>
                                </motion.div>
                            )}

                            <div className="mt-4 grid gap-2" aria-live="polite">
                                {!hasWallet() && (
                                    <p className="measure m-0 text-sm text-dim">
                                        This needs the browser wallet you paid with. Open this page in that browser.
                                    </p>
                                )}
                                {state.k === "failed" && (
                                    <p className="measure m-0 text-sm text-flag" role="alert">{state.why}</p>
                                )}
                            </div>
                        </motion.div>
                    </div>
                </section>

                {/* What the wallet holds and what it has spent, side by side, because the next purchase
                    depends on the first and the second is the only history that exists. */}
                <div className="grid border-b border-line sm:grid-cols-2 lg:grid-cols-4">
                    <Figure k="Briefs owned" v={state.k === "open" ? String(receipts.length) : "—"} />
                    <Figure k="Spent" v={state.k === "open" ? formatUsdc(spent) : "—"} unit="USDC" />
                    <Figure k="USDC balance" v={balance ?? "—"} unit={balance === null ? "connect to read" : "spendable"} />
                    <Figure k="Price now" v={terms?.briefPriceUsd?.replace("$", "") ?? "—"} unit="per brief" />
                </div>

                <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <div>
                            <p className="m-0 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-dim">
                                Purchases
                            </p>
                        </div>
                        <div className="min-w-0">
                            {state.k !== "open" ? (
                                <p className="measure text-dim">
                                    Nothing to show until a wallet has signed. The agent cannot look a buyer up any
                                    other way, which is the point: there is nothing to look up.
                                </p>
                            ) : receipts.length === 0 ? (
                                <p className="measure text-dim">
                                    This wallet has not bought anything here. If you paid from a different one, connect
                                    that instead. <a className="text-ink underline underline-offset-4" href="/">Browse the briefs</a>.
                                </p>
                            ) : (
                                <div className="border-t border-line">
                                    {receipts.map((r, i) => {
                                        const link = explorerTx(terms?.network ?? null, r.transaction);
                                        return (
                                            <Reveal key={r.id} delay={Math.min(i, 6) * 0.05}>
                                                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-line py-4">
                                                    <a
                                                        href={r.url}
                                                        className="min-w-[8rem] font-mono text-sm text-ink no-underline [border-bottom:1px_solid_var(--color-line)] hover:[border-bottom-color:var(--color-lime)]"
                                                    >
                                                        Open brief ↗
                                                    </a>
                                                    <span className="flex-1 text-[0.9375rem] text-dim">{r.briefId}</span>
                                                    <span className="font-mono text-xs text-dim">
                                                        {new Date(r.at).toLocaleDateString()}
                                                    </span>
                                                    {link === null ? (
                                                        <span className="font-mono text-xs text-dim" title={r.transaction}>
                                                            {shortHash(r.transaction)}
                                                        </span>
                                                    ) : (
                                                        <a
                                                            href={link.url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            title={r.transaction}
                                                            className="font-mono text-xs text-dim no-underline hover:text-ink"
                                                        >
                                                            {shortHash(r.transaction)} ↗
                                                        </a>
                                                    )}
                                                    <span className="num min-w-[6rem] text-right font-mono text-sm text-ink">
                                                        {formatUsdc(r.amountUsdcMinor)}
                                                    </span>
                                                </div>
                                            </Reveal>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            </main>

            <Footer>
                <span>Signing proves the wallet is yours. It authorises reading, nothing else.</span>
                <span>Research is informational and is not investment advice.</span>
            </Footer>
        </>
    );
}

function Figure({ k, v, unit }: { k: string; v: string; unit?: string }) {
    const countable = /^[\d.]+$/.test(v);
    return (
        <div className="border-b border-line px-[var(--gut)] py-5 last:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b-0">
            <span className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.11em] text-dim">{k}</span>
            <span className="mt-2.5 block font-mono text-[1.75rem] leading-none tracking-[-0.025em] text-ink">
                {countable ? <CountUp value={v} /> : v}
                {unit !== undefined && (
                    <small className="ml-1.5 text-[0.6875rem] font-normal tracking-normal text-dim">{unit}</small>
                )}
            </span>
        </div>
    );
}
