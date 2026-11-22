import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InvestmentGap } from "./api";
import {
    api, formatUsdc, ApiError,
    type Mandate, type OwnerBrief, type Proposal, type SyncResult, type InvestLedger, type ExecuteResult,
    type ExecutionStatus, type PositionsView,
} from "./api";
import { signTypedData, currentAccount, describeWalletError } from "./wallet";

/** Everything the desk can be in the middle of, so the screen always says which. */
type Busy = null | "sync" | "propose" | "approve" | "execute";

interface Note {
    tone: "ok" | "stop";
    title: string;
    lines: string[];
}

const COUNTDOWN_TICK_MS = 1000;

export function Desk({ address, onSignedOut }: { address: string; onSignedOut: () => void }) {
    const [mandate, setMandate] = useState<Mandate | null>(null);
    const [brief, setBrief] = useState<OwnerBrief | null>(null);
    const [ledger, setLedger] = useState<InvestLedger | null>(null);
    const [sync, setSync] = useState<SyncResult | null>(null);
    const [proposal, setProposal] = useState<Proposal | null>(null);
    const [fills, setFills] = useState<ExecuteResult | null>(null);
    const [execution, setExecution] = useState<ExecutionStatus | null>(null);
    const [positions, setPositions] = useState<PositionsView | null>(null);
    const [busy, setBusy] = useState<Busy>(null);
    const [note, setNote] = useState<Note | null>(null);
    const [left, setLeft] = useState<number | null>(null);
    const deadline = useRef<number | null>(null);

    const refresh = useCallback(async () => {
        const [m, l, x, p] = await Promise.all([
            api.mandate(), api.ledger(), api.execution(), api.positions(),
        ]);
        setMandate(m);
        setLedger(l);
        setExecution(x);
        setPositions(p);
        try {
            setBrief(await api.brief());
        } catch {
            setBrief(null); // no catalogue brief yet is a state, not a failure
        }
    }, []);

    useEffect(() => {
        void refresh().catch((e: unknown) => setNote(stop("Could not load the desk", e)));
    }, [refresh]);

    // The approval really is expiring, so the clock is the one thing that moves on its own.
    useEffect(() => {
        if (deadline.current === null) return;
        const tick = () => setLeft(Math.max(0, Math.round((deadline.current! - Date.now()) / 1000)));
        tick();
        const h = setInterval(tick, COUNTDOWN_TICK_MS);
        return () => clearInterval(h);
    }, [proposal]);

    function stop(title: string, e: unknown): Note {
        const lines = e instanceof ApiError && e.reasons.length > 0 ? e.reasons : [describeWalletError(e)];
        return { tone: "stop", title, lines };
    }

    async function run(what: Busy, fn: () => Promise<Note | null>) {
        setBusy(what);
        setNote(null);
        try {
            setNote(await fn());
        } catch (e) {
            setNote(stop(labelFor(what), e));
        } finally {
            setBusy(null);
        }
    }

    const doSync = () =>
        run("sync", async () => {
            const r = await api.sync();
            setSync(r);
            await refresh();
            const investable = BigInt(r.investableUsdcMinor);
            if (investable > 0n) return null;
            // Not an error. The agent declining to invest money it has not earned is the design working.
            return {
                tone: "ok",
                title: "Nothing to invest, and that is correct",
                lines: [
                    `Earned ${formatUsdc(r.revenueUsdcMinor)} across ${r.sales} sale(s), spent ${formatUsdc(r.costsUsdcMinor)} on ${r.briefsCosted} brief(s).`,
                    ...gapLines(r.gap),
                    ...r.unreadableBriefs.map((b) => `Brief file ${b.file} could not be read, so its cost is missing: ${b.error}`),
                ],
            };
        });

    const doPropose = () =>
        run("propose", async () => {
            const p = await api.propose();
            setProposal(p);
            setFills(null);
            deadline.current = Date.now() + Number(p.toSign.message.issuedAt) * 0 + expirySeconds(mandate) * 1000;
            return p.warnings.length === 0
                ? null
                : { tone: "ok", title: "Proposed, with notes", lines: p.warnings };
        });

    const doApprove = () =>
        run("approve", async () => {
            if (proposal === null) return null;
            const signature = await signTypedData(address, proposal.toSign);
            const r = await api.approve(proposal.id, signature);
            setProposal({ ...proposal, state: "APPROVED" });
            return {
                tone: "ok",
                title: "Approved",
                lines: [`Signed by ${r.signer}. Valid until ${new Date(r.expiresAt).toLocaleTimeString()}.`],
            };
        });

    const doExecute = () =>
        run("execute", async () => {
            if (proposal === null) return null;
            const r = await api.execute(proposal.id);
            setFills(r);
            setProposal({ ...proposal, state: "SETTLED" });
            await refresh();
            return {
                tone: "ok",
                title: r.simulated ? "Filled, simulated" : "Filled",
                lines: [
                    `${r.fills.length} fill(s) at the quoted prices.`,
                    ...(r.simulated ? ["Fills are simulated and the book is tagged sim. No token moved."] : []),
                    ...r.warnings,
                ],
            };
        });

    async function doSignOut() {
        await api.logout();
        onSignedOut();
    }

    const claimsById = useMemo(() => {
        const m = new Map<string, OwnerBrief["themes"][number]["claims"][number]>();
        for (const t of brief?.themes ?? []) for (const c of t.claims) m.set(c.id, c);
        return m;
    }, [brief]);

    const sourcesById = useMemo(() => {
        const m = new Map<string, OwnerBrief["sources"][number]>();
        for (const s of brief?.sources ?? []) m.set(s.id, s);
        return m;
    }, [brief]);

    const investable = ledger?.balances["surplus.investable"] ?? "0";

    return (
        <>
            <header className="stage">
                <div className="wrap">
                    <div className="bar">
                        <span className="mark">
                            <svg width="22" height="12" viewBox="0 0 22 12" fill="none" aria-hidden="true">
                                <path d="M1 8c3-7 6.5-7 9.5 0s6.5 7 9.5 0" stroke="#F4EDE0" strokeWidth="1.6" strokeLinecap="round" />
                            </svg>
                            Surplus
                        </span>
                        <nav aria-label="Desk">
                            <a href="#decision" aria-current="page">Decision</a>
                            <a href="#book">Book</a>
                        </nav>
                        {left !== null && proposal !== null && (
                            <span className="pillbtn live num" title="Time left on this approval">
                                {left === 0 ? "0:00" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
                            </span>
                        )}
                        <button className="pillbtn" onClick={() => void doSignOut()} title={`Signed in as ${address}`}>
                            out
                        </button>
                    </div>

                    <div className="hero" id="decision">
                        <div>
                            <h1>{headline(proposal, investable)}</h1>
                            <p className="lede">{subhead(proposal, investable, sync)}</p>

                            {execution !== null && <RealMoneyNotice execution={execution} />}

                            <div className="cta">
                                {proposal === null ? (
                                    <>
                                        <button className="btn" onClick={() => void doSync()} disabled={busy !== null}>
                                            {busy === "sync" ? "Reading the books…" : "Sync revenue"} <span aria-hidden="true">↗</span>
                                        </button>
                                        <button
                                            className="textlink"
                                            onClick={() => void doPropose()}
                                            disabled={busy !== null || BigInt(investable) <= 0n}
                                        >
                                            {busy === "propose" ? "Quoting…" : "Propose a trade"} <span aria-hidden="true">↗</span>
                                        </button>
                                    </>
                                ) : proposal.state === "PROPOSED" ? (
                                    <>
                                        <button className="btn" onClick={() => void doApprove()} disabled={busy !== null}>
                                            {busy === "approve" ? "Waiting for your wallet…" : "Review and sign"} <span aria-hidden="true">↗</span>
                                        </button>
                                        <button className="textlink" onClick={() => setProposal(null)} disabled={busy !== null}>
                                            Refuse this proposal
                                        </button>
                                    </>
                                ) : proposal.state === "APPROVED" ? (
                                    <>
                                        <button className="btn" onClick={() => void doExecute()} disabled={busy !== null}>
                                            {busy === "execute"
                                                ? "Re-quoting and filling…"
                                                : execution?.willSendRealSwaps === true
                                                    ? "Execute with real money"
                                                    : "Execute, simulated"}{" "}
                                            <span aria-hidden="true">↗</span>
                                        </button>
                                        <button className="textlink" onClick={() => setProposal(null)} disabled={busy !== null}>
                                            Discard
                                        </button>
                                    </>
                                ) : (
                                    <button className="btn" onClick={() => setProposal(null)}>
                                        Start another <span aria-hidden="true">↗</span>
                                    </button>
                                )}
                            </div>
                        </div>

                        <aside className="panel" aria-label="Summary">
                            <div className="grip" aria-hidden="true" />
                            <p className="where">
                                {ledger?.simulatedFills === false ? "Live fills" : "Simulated fills"} ·{" "}
                                {mandate === null ? "loading" : `mandate v${mandate.version} ${mandate.hash.slice(0, 8)}`}
                            </p>

                            <div className="slab">
                                <div className="top">
                                    <span className="name">Investable</span>
                                    <span className="rate">{mandate === null ? "" : `${mandate.terms.investShareBps / 100}% share`}</span>
                                </div>
                                <div className="row">
                                    <span>
                                        <span className="k">USDC</span>
                                        <span className="v num">{formatUsdc(investable)}</span>
                                    </span>
                                    <span className="chip">reserve {formatUsdc(ledger?.balances["reserve"] ?? "0")}</span>
                                </div>
                            </div>

                            {proposal !== null && (
                                <div className="slab">
                                    <div className="top">
                                        <span className="name">{proposal.id}</span>
                                        <span className="rate">{proposal.state.toLowerCase()}</span>
                                    </div>
                                    <div className="row">
                                        <span>
                                            <span className="k">Legs</span>
                                            <span className="v num">{proposal.legs.length}</span>
                                        </span>
                                        <span className="chip">{proposal.swaps.length} swaps</span>
                                        <span style={{ textAlign: "right" }}>
                                            <span className="k">USDC</span>
                                            <span className="v num">{formatUsdc(proposal.totalUsdcIn)}</span>
                                        </span>
                                    </div>
                                </div>
                            )}

                            {ledger !== null && !ledger.reconcile.ok && (
                                <span className="flag">Books do not reconcile</span>
                            )}
                        </aside>
                    </div>

                    {note !== null && (
                        <section className="sheet" style={{ marginTop: "2rem", marginBottom: "1rem" }}>
                            <h3 style={{ color: note.tone === "stop" ? "var(--coral)" : "var(--cream)" }}>{note.title}</h3>
                            <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--cream-dim)", fontSize: ".9375rem" }}>
                                {note.lines.map((l) => (
                                    <li key={l} style={{ marginBottom: ".3rem" }}>{l}</li>
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            </header>

            <main className="work" id="book">
                <div className="wrap">
                    {proposal !== null ? (
                        <>
                            <h2>What each amount is standing on</h2>
                            <p>
                                Open a row to read the filing sentence behind it. A fact with no verbatim quote
                                never reached this page.
                            </p>
                            <ul className="legs">
                                {proposal.legs.map((leg, i) => {
                                    const theme = brief?.themes.find((t) => t.themeId === leg.theme);
                                    const fit = theme?.fits.find((f) => f.symbol === leg.symbol);
                                    const claim = fit?.claimIds[0] === undefined ? undefined : claimsById.get(fit.claimIds[0]);
                                    const quote = claim?.quotes?.[0];
                                    const source = quote === undefined ? undefined : sourcesById.get(quote.sourceId);
                                    return (
                                        <li key={`${leg.theme}:${leg.symbol}:${i}`}>
                                            <details className="leg" open={i === 0}>
                                                <summary>
                                                    <span className="sym">{leg.symbol}</span>
                                                    <span className="theme">{leg.theme}</span>
                                                    <span className="amt num">{formatUsdc(leg.usdcIn)}</span>
                                                    <span className="caret" aria-hidden="true">▾</span>
                                                </summary>
                                                <div className="evidence">
                                                    <p className="claim">
                                                        {claim?.text ?? "No claim was carried through for this leg."}
                                                    </p>
                                                    {quote !== undefined && <blockquote>“{quote.text}”</blockquote>}
                                                    <p className="cite">
                                                        <span>
                                                            {source === undefined
                                                                ? "source not in this brief"
                                                                : `${source.title}${source.publishedAt === null ? "" : `, filed ${source.publishedAt}`}`}
                                                        </span>
                                                        {quote !== undefined && <span className="ok">quote found verbatim</span>}
                                                    </p>
                                                    <p className="scores">
                                                        fit <b>{fit?.fit ?? "—"}</b>/5
                                                        <br />
                                                        evidence <b>{fit?.evidence ?? "—"}</b>/5
                                                    </p>
                                                </div>
                                            </details>
                                        </li>
                                    );
                                })}
                            </ul>

                            {fills !== null && (
                                <section className="sheet" style={{ marginTop: "2rem" }}>
                                    <h3>{fills.simulated ? "Simulated fills" : "Fills"}</h3>
                                    <dl>
                                        {fills.fills.map((f) => (
                                            <div key={f.symbol + f.quantity} style={{ display: "contents" }}>
                                                <dt>{f.symbol}</dt>
                                                <dd className="num">{formatUsdc(f.usdcIn)} USDC</dd>
                                            </div>
                                        ))}
                                    </dl>
                                </section>
                            )}
                        </>
                    ) : (
                        <>
                            <h2>The book</h2>
                            <p>
                                Every line is double-entry, append-only, and tagged with the mode it happened in.
                                {ledger === null ? "" : ` Reconciliation: ${ledger.reconcile.ok ? "clean" : ledger.reconcile.issues.join("; ")}.`}
                            </p>
                            {positions !== null && <AgainstTheChain positions={positions} />}
                            <ul className="legs">
                                {(ledger?.entries ?? []).map((e) => {
                                    const cash = e.lines.find((l) => l.account === "cash.operating");
                                    return (
                                        <li key={e.id}>
                                            <div className="leg">
                                                <div className="leg-row">
                                                    <span className="sym">{e.type.replace(/_/g, " ").toLowerCase()}</span>
                                                    <span className="theme">
                                                        {e.briefId ?? e.memo ?? ""} · {e.mode}
                                                    </span>
                                                    <span className="amt num">
                                                        {cash === undefined ? "" : formatUsdc(cash.amount)}
                                                    </span>
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                                {(ledger?.entries.length ?? 0) === 0 && (
                                    <li>
                                        <div className="leg">
                                            <div className="leg-row">
                                                <span className="theme">
                                                    Nothing booked yet. Sync revenue once a brief has sold.
                                                </span>
                                            </div>
                                        </div>
                                    </li>
                                )}
                            </ul>
                        </>
                    )}
                </div>
            </main>
        </>
    );
}

function labelFor(what: Busy): string {
    if (what === "sync") return "Could not sync revenue";
    if (what === "propose") return "Nothing was proposed";
    if (what === "approve") return "Not approved";
    if (what === "execute") return "Stopped before execution";
    return "Something went wrong";
}

const expirySeconds = (m: Mandate | null): number => m?.terms.approvalExpirySeconds ?? 600;

/**
 * What is actually in the way, in money rather than advice.
 *
 * "Sell more briefs" is true and useless. An owner needs to know whether this is one sale away or a
 * hundred, and the agent can say so exactly, by the same rules it settles with.
 */
export function gapLines(gap: InvestmentGap | undefined): string[] {
    if (gap === undefined || gap.canInvest) return [];
    if (gap.revenueNeededUsdcMinor === "0") {
        return ["The mandate invests none of the surplus, so no amount of revenue would change this. Raise the invest share to change it."];
    }
    const parts: string[] = [];
    if (gap.shortfallUsdcMinor !== "0") parts.push(`${formatUsdc(gap.shortfallUsdcMinor)} to cover what it has already spent`);
    if (gap.reserveGapUsdcMinor !== "0") parts.push(`${formatUsdc(gap.reserveGapUsdcMinor)} to fill the protected reserve`);
    if (gap.surplusNeededUsdcMinor !== "0") parts.push(`${formatUsdc(gap.surplusNeededUsdcMinor)} of surplus so the invest share clears the smallest allowed trade`);
    return [
        `${formatUsdc(gap.revenueNeededUsdcMinor)} USDC more revenue would make a trade possible: ${parts.join(", then ")}.`,
        "Selling another brief also costs something to produce, so that figure is a floor, not a forecast.",
    ];
}

/**
 * The books against the wallet.
 *
 * The reconciliation line above it says the books agree with themselves. This says whether they are
 * true, which is a different question and the only one a holder of the tokens actually cares about.
 */
function AgainstTheChain({ positions }: { positions: PositionsView }) {
    if (!positions.checked) {
        return (
            <p className="note">
                Against the chain: nothing to compare. {positions.why ?? "Fills are simulated."}
            </p>
        );
    }
    if (positions.positions.length === 0) {
        return <p className="note">Against the chain: nothing bought yet, so nothing to hold.</p>;
    }
    return (
        <div className={positions.ok === false ? "notice real" : "notice"}>
            <p>
                <strong>
                    {positions.ok === false
                        ? "The wallet does not hold what the books say."
                        : "The wallet holds what the books say."}
                </strong>
            </p>
            <ul className="legs">
                {positions.positions.map((p) => (
                    <li key={p.asset}>
                        <div className="leg">
                            <div className="leg-row">
                                <span className="sym">{p.symbol}</span>
                                <span className="theme">
                                    booked {p.bookedUnits} units, wallet holds {p.heldUnits}
                                    {p.verdict === "matches" ? "" : ` (${p.verdict}, ${p.differenceUnits})`}
                                </span>
                            </div>
                        </div>
                    </li>
                ))}
            </ul>
            {positions.issues.map((i) => (
                <p className="note error" key={i}>{i}</p>
            ))}
        </div>
    );
}

/**
 * What executing would really do, said before the button is pressed rather than after.
 *
 * The distinction is the whole difference between a rehearsal and spending money, and it cannot be
 * read off the configuration: mainnet with no key still simulates. So the agent is asked, and what it
 * answers is what is shown.
 */
function RealMoneyNotice({ execution }: { execution: ExecutionStatus }) {
    const real = execution.willSendRealSwaps;
    return (
        <div className={real ? "notice real" : "notice"}>
            <p>
                <strong>{real ? "Executing will spend real money." : "Fills are simulated."}</strong>{" "}
                {real
                    ? `Swaps are sent from ${execution.address ?? "the execution wallet"} on Base mainnet.`
                    : execution.why ?? "No token moves and the book is tagged sim."}
            </p>
            {real && execution.remainingUsdcMinor !== undefined && (
                <p className="note">
                    {formatUsdc(execution.remainingUsdcMinor)} USDC of the spend cap is left,{" "}
                    {formatUsdc(execution.spentUsdcMinor ?? "0")} already committed.
                </p>
            )}
            {execution.unresolved.length > 0 && (
                <p className="note error">
                    {execution.unresolved.length} transaction(s) signed with no known outcome:{" "}
                    {execution.unresolved.map((x) => `${x.symbol} ${x.txHash?.slice(0, 10) ?? "unsent"}`).join(", ")}.
                    The agent resolves these against the chain when it starts.
                </p>
            )}
        </div>
    );
}

function headline(p: Proposal | null, investable: string): string {
    if (p === null) {
        return BigInt(investable) > 0n
            ? "There is surplus to put to work."
            : "Nothing moves until you sign.";
    }
    if (p.state === "PROPOSED") return `The agent wants to buy ${p.legs.length} positions.`;
    if (p.state === "APPROVED") return "Approved. Execute when you are ready.";
    return "Done. The book has been written.";
}

function subhead(p: Proposal | null, investable: string, sync: SyncResult | null): string {
    if (p !== null) {
        return "Every amount below carries the sentence from the filing it came from. Open a row to read it.";
    }
    if (BigInt(investable) > 0n) {
        return `${formatUsdc(investable)} USDC is investable. Ask for a proposal and the agent will quote it live.`;
    }
    if (sync !== null) {
        const gap = sync.gap;
        if (gap !== undefined && !gap.canInvest && gap.revenueNeededUsdcMinor !== "0") {
            return `Nothing is investable yet. ${formatUsdc(gap.revenueNeededUsdcMinor)} USDC more revenue would change that. The agent not investing money it has not earned is the rule working, not a failure.`;
        }
        return "The agent has not earned more than it spent, so there is nothing to invest. That is the rule working, not a failure.";
    }
    return "Sync the books to see what the agent has earned and what, if anything, is investable.";
}
