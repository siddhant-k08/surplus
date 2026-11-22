import { useEffect, useState } from "react";
import { formatUsdc, recoverReceipts, recoveryOffer, type RecoveredReceipt } from "./api";
import { describeWalletError, readUsdcBalance, signTypedData } from "./wallet";
import { Button, Figures, Footer, Note, SiteHeader, Spine } from "./Chrome";
import { ConnectRow, WalletChip, useWallet } from "./Connect";
import { MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { explorerTx, networkName, shortHash } from "./explorer";

/**
 * Everything one wallet has bought, in one place.
 *
 * Recovery existed before this, but only as a rescue: a line on the storefront for someone who had
 * lost a link. That is the wrong shape for the thing a buyer comes back to. A wallet that has bought
 * four briefs has a portfolio, a running total, and a balance it can spend on the next one.
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
    | { k: "closed" }
    | { k: "opening" }
    | { k: "open"; address: string; receipts: RecoveredReceipt[] }
    | { k: "failed"; why: string };

export function Portfolio({ terms }: { terms: Terms | null }) {
    const [state, setState] = useState<State>({ k: "closed" });
    const [balance, setBalance] = useState<string | null>(null);
    const wallet = useWallet();

    // What the wallet can actually spend. Read through the wallet's own provider rather than a public
    // RPC: it is already connected to the right chain, and the page gains no new host to trust.
    useEffect(() => {
        if (wallet.address === null || terms === null) return;
        let live = true;
        void readUsdcBalance(wallet.address, terms.asset)
            .then((b) => { if (live) setBalance(b); })
            .catch(() => { if (live) setBalance(null); });
        return () => { live = false; };
    }, [wallet.address, terms]);

    // A different wallet is a different portfolio, so what the last one proved is dropped.
    useEffect(() => { setState({ k: "closed" }); }, [wallet.address]);

    async function open() {
        if (wallet.address === null) return;
        setState({ k: "opening" });
        try {
            const offer = await recoveryOffer(wallet.address);
            const signature = await signTypedData(wallet.address, offer);
            const result = await recoverReceipts({ address: wallet.address, nonce: offer.message.nonce, signature });
            setState({ k: "open", address: result.address, receipts: result.receipts });
        } catch (e) {
            setState({ k: "failed", why: describeWalletError(e) });
        }
    }

    const chain = networkName(terms?.network) ?? "Base Sepolia";
    const receipts = state.k === "open" ? state.receipts : [];
    const spent = receipts.reduce((a, r) => a + BigInt(r.amountUsdcMinor), 0n);
    const connected = wallet.address !== null;

    return (
        <>
            <SiteHeader
                here="portfolio"
                right={
                    <>
                        <WalletChip wallet={wallet} />
                        <Button href="/app" tone="ghost" size="sm">Buy a brief</Button>
                    </>
                }
            />

            <main id="main">
                <section className="border-b border-line">
                    <div className="shell band py-[clamp(2.25rem,5vw,3.25rem)]">
                        <Spine label="Your portfolio" aside="One wallet, everything it owns." />
                        <motion.div variants={stagger()} initial="hidden" animate="shown" className="min-w-0">
                            <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                <MaskedLine delay={0.1}>Everything this wallet bought.</MaskedLine>
                            </h1>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                No account and no email. Sign once with the wallet that paid and the agent hands back
                                every brief it bought, with the settlement behind each one.
                            </motion.p>

                            <motion.div variants={riseItem} className="mt-7">
                                <ConnectRow wallet={wallet} chain={chain} />
                            </motion.div>

                            {connected && state.k !== "open" && (
                                <motion.div variants={riseItem} className="mt-6">
                                    <Button onClick={() => void open()} disabled={state.k === "opening"}>
                                        {state.k === "opening" ? "Check your wallet…" : "Prove it is yours"}
                                        <span aria-hidden="true">↗</span>
                                    </Button>
                                    <p className="mt-3 font-mono text-xs text-dim">
                                        A signature, not a transaction. It costs nothing and moves nothing.
                                    </p>
                                </motion.div>
                            )}

                            <div className="mt-4 grid gap-2" aria-live="polite">
                                {state.k === "failed" && <Note tone="bad" alert>{state.why}</Note>}
                            </div>
                        </motion.div>
                    </div>
                </section>

                {/* What the wallet holds and what it has spent, side by side, because the next purchase
                    depends on the first and the second is the only history that exists. */}
                <Figures
                    cells={[
                        { k: "Briefs owned", v: state.k === "open" ? String(receipts.length) : "—" },
                        { k: "Spent", v: state.k === "open" ? formatUsdc(spent) : "—", unit: "USDC" },
                        {
                            k: "USDC balance",
                            v: balance ?? "—",
                            unit: balance === null ? (connected ? "could not read" : "connect to read") : "spendable",
                        },
                        { k: "Price now", v: terms?.briefPriceUsd?.replace("$", "") ?? "—", unit: "per brief" },
                    ]}
                />

                <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
                    <div className="shell band">
                        <Spine label="Purchases" aside={state.k === "open" ? `Signed as ${shortHash(state.address, 6, 4)}.` : undefined} />
                        <div className="min-w-0">
                            {state.k !== "open" ? (
                                <p className="measure text-dim">
                                    Nothing to show until a wallet has signed. The agent cannot look a buyer up any
                                    other way, which is the point: there is nothing to look up.
                                </p>
                            ) : receipts.length === 0 ? (
                                <p className="measure text-dim">
                                    This wallet has not bought anything here. If you paid from a different one, connect
                                    that instead.{" "}
                                    <a className="text-ink underline underline-offset-4" href="/app">Buy a brief</a>.
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
