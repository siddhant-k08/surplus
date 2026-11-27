import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import type { InvestmentGap } from "./api";
import {
    api, formatUsdc, ApiError,
    type Mandate, type OwnerBrief, type Proposal, type SyncResult, type InvestLedger, type ExecuteResult,
    type ExecutionStatus, type PositionsView, type BriefClaim, type BriefSource,
} from "./api";
import { signTypedData, currentAccount, describeWalletError, ensureChain } from "./wallet";
import { EvidenceBody, WhatAQuoteProves, count } from "./Evidence";
import { MandatePanel } from "./MandatePanel";
import { Button, Chip, Footer, Led, NavLink, TopBar } from "./Chrome";
import { CountUp, Reveal, riseItem, stagger , motion } from "./motion";
import { STEPS, activeStep, stepStates, type StepState } from "./steps";
import { bpsToPercent } from "./terms";
import { navigate } from "./App";

export type DeskTab = "decision" | "mandate" | "book";

/** Everything the desk can be in the middle of, so the screen always says which. */
type Busy = null | "sync" | "propose" | "approve" | "execute";

interface Note {
    tone: "ok" | "stop";
    title: string;
    lines: string[];
}

const COUNTDOWN_TICK_MS = 1000;

export function Desk({ tab, address, onSignedOut }: { tab: DeskTab; address: string; onSignedOut: () => void }) {
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
    const [loading, setLoading] = useState(true);
    const [left, setLeft] = useState<number | null>(null);
    const deadline = useRef<number | null>(null);

    const refresh = useCallback(async () => {
        const [m, l, x, p] = await Promise.all([api.mandate(), api.ledger(), api.execution(), api.positions()]);
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
        void refresh()
            .catch((e: unknown) => setNote(stop("Could not load the desk", e)))
            .finally(() => setLoading(false));
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
            if (BigInt(r.investableUsdcMinor) > 0n) return null;
            // Not an error. The agent declining to invest money it has not earned is the design working.
            return {
                tone: "ok",
                title: "Nothing to invest, and that is correct",
                lines: [
                    `Earned ${formatUsdc(r.revenueUsdcMinor)} across ${count(r.sales, "sale")}, spent ${formatUsdc(r.costsUsdcMinor)} on ${count(r.briefsCosted, "brief")}.`,
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
            deadline.current = Date.now() + expirySeconds(mandate) * 1000;
            return p.warnings.length === 0 ? null : { tone: "ok", title: "Proposed, with notes", lines: p.warnings };
        });

    const doApprove = () =>
        run("approve", async () => {
            if (proposal === null) return null;
            // A wallet can change accounts between signing in and approving, and the session would not
            // know. Asking it to sign as an account it no longer holds fails inside the wallet with a
            // message about `from`, which says nothing about what to do.
            const selected = currentAccount();
            if (selected !== null && selected.toLowerCase() !== address.toLowerCase()) {
                throw new Error(
                    `Your wallet has switched to ${selected}, but this session is signed in as ${address}. ` +
                    "Switch back to that account, or sign out and sign in again.",
                );
            }
            // The domain pins a chain, and a session outlives the wallet staying on it.
            await ensureChain((proposal.toSign as { domain: { chainId: number } }).domain.chainId);
            const signature = await signTypedData(address, proposal.toSign);
            const r = await api.approve(proposal.id, signature);
            setProposal({ ...proposal, state: "APPROVED" });
            deadline.current = Date.parse(r.expiresAt);
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
                title: r.simulated ? "Filled, simulated" : "Filled with real money",
                lines: [
                    `${count(r.fills.length, "fill")} at the quoted prices.`,
                    ...(r.simulated
                        ? ["No token moved. The book is tagged sim and the wallet holds nothing new."]
                        : ["Tokens moved onchain. Check the positions panel against the books."]),
                    ...r.warnings,
                ],
            };
        });

    async function doSignOut() {
        await api.logout();
        onSignedOut();
    }

    function startAgain() {
        setProposal(null);
        setFills(null);
        deadline.current = null;
        setLeft(null);
        setNote(null);
    }

    const claimsById = useMemo(() => {
        const m = new Map<string, BriefClaim>();
        for (const t of brief?.themes ?? []) for (const c of t.claims) m.set(c.id, c);
        return m;
    }, [brief]);

    const sourcesById = useMemo(() => {
        const m = new Map<string, BriefSource>();
        for (const s of brief?.sources ?? []) m.set(s.id, s);
        return m;
    }, [brief]);

    const investable = ledger?.balances["surplus.investable"] ?? "0";
    const expired = proposal?.state === "APPROVED" && left === 0;
    const states = stepStates({ proposal, investableMinor: investable, synced: sync, fills, expired });
    const step = activeStep(states);

    return (
        <>
            <TopBar
                nav={
                    <>
                        <DeskLink to="/desk" current={tab === "decision"}>Decision</DeskLink>
                        <DeskLink to="/desk/mandate" current={tab === "mandate"}>Mandate</DeskLink>
                        <DeskLink to="/desk/book" current={tab === "book"}>Book</DeskLink>
                        <NavLink href="/">Home</NavLink>
                    </>
                }
                right={
                    <>
                        {left !== null && proposal !== null && (
                            <Chip title="Time left on this approval">
                                <span className={expired === true ? "text-flag" : "text-lime"}>
                                    {left === 0 ? "expired" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
                                </span>
                            </Chip>
                        )}
                        {ledger !== null && (
                            <Chip title={ledger.simulatedFills ? "No token moves" : "Real swaps"}>
                                <Led className={ledger.simulatedFills ? "bg-dim" : "bg-amber"} />
                                {ledger.simulatedFills ? "simulated" : "live"}
                            </Chip>
                        )}
                        <Button tone="ghost" size="sm" onClick={() => void doSignOut()} title={`Signed in as ${address}`}>
                            Sign out
                        </Button>
                    </>
                }
            />

            <main id="main">
                {tab === "decision" && (
                    <>
                        <StepRail states={states} />
                        <section className="border-b border-line">
                            <div className="shell grid items-start gap-10 py-[clamp(2rem,4vw,3rem)] lg:grid-cols-[1fr_21rem]">
                                <motion.div variants={stagger()} initial="hidden" animate="shown">
                                    {loading ? (
                                        <>
                                            <h1 className="text-[clamp(2rem,4vw,2.9rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                                Opening the books…
                                            </h1>
                                            <p className="measure mt-5 text-[1.0625rem]" role="status">
                                                Reading the ledger, the mandate and the chain.
                                            </p>
                                        </>
                                    ) : (
                                        <>
                                            <motion.h1
                                                variants={riseItem}
                                                className="text-[clamp(2rem,4vw,2.9rem)] font-medium leading-[1.04] tracking-[-0.045em]"
                                            >
                                                {headline(proposal, investable, expired === true)}
                                            </motion.h1>
                                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                                {subhead(proposal, investable, sync, expired === true)}
                                            </motion.p>
                                        </>
                                    )}

                                    {/* Said before the button, never inferred from configuration. */}
                                    {execution !== null && (step === 4 || fills !== null) && (
                                        <RealMoneyNotice execution={execution} />
                                    )}

                                    <motion.div variants={riseItem} className="mt-7 flex flex-wrap items-center gap-4">
                                        <Actions
                                            proposal={proposal}
                                            fills={fills}
                                            busy={busy}
                                            loading={loading}
                                            expired={expired === true}
                                            investable={investable}
                                            realSwaps={execution?.willSendRealSwaps === true}
                                            onSync={doSync}
                                            onPropose={doPropose}
                                            onApprove={doApprove}
                                            onExecute={doExecute}
                                            onReset={startAgain}
                                        />
                                    </motion.div>

                                    {proposal !== null && fills === null && (
                                        // The limitation worth stating while it matters: this proposal lives in the
                                        // running process and in this tab. Pretending otherwise would be worse.
                                        <p className="measure mt-5 text-sm text-dim">
                                            This proposal lives in this tab and in the running agent. Reloading, or the
                                            agent restarting, loses it. Nothing is lost but the quote: sync and request
                                            another and the money is still there.
                                        </p>
                                    )}
                                </motion.div>

                                <Reveal delay={0.1}>
                                    <aside aria-label="Where you stand" className="grid gap-4">
                                        <Box title="The books">
                                            <Figures
                                                rows={[
                                                    ["Investable", formatUsdc(investable)],
                                                    ["Reserve", formatUsdc(ledger?.balances["reserve"] ?? "0")],
                                                    ["Invest share", mandate === null ? "—" : `${bpsToPercent(mandate.terms.investShareBps)}%`],
                                                    ["Mandate", mandate === null ? "—" : `v${mandate.version}`],
                                                ]}
                                            />
                                            <p className={`mt-3 text-xs ${ledger?.reconcile.ok === false ? "text-flag" : "text-dim"}`}>
                                                {ledger === null
                                                    ? "Reading the book…"
                                                    : ledger.reconcile.ok
                                                        ? "Books reconcile."
                                                        : `Books do not reconcile: ${ledger.reconcile.issues.join("; ")}`}
                                            </p>
                                        </Box>

                                        {proposal !== null && (
                                            <Box title="This proposal">
                                                <Figures
                                                    rows={[
                                                        ["Total", formatUsdc(proposal.totalUsdcIn)],
                                                        ["Legs", String(proposal.legs.length)],
                                                        ["Swaps", String(proposal.swaps.length)],
                                                        ["State", proposal.state.toLowerCase()],
                                                    ]}
                                                />
                                                <p className="mt-3 font-mono text-xs text-dim" title={proposal.hash}>
                                                    Signed over proposal {proposal.hash.slice(0, 10)} and mandate v{proposal.mandateVersion}.
                                                </p>
                                            </Box>
                                        )}

                                        {execution !== null && execution.unresolved.length > 0 && (
                                            <Box title="Unresolved onchain" alarm>
                                                <p className="m-0 text-sm text-flag">
                                                    {count(execution.unresolved.length, "transaction")} signed with no known
                                                    outcome: {execution.unresolved.map((x) => `${x.symbol} ${x.txHash?.slice(0, 10) ?? "unsent"}`).join(", ")}.
                                                    The agent resolves these against the chain when it starts.
                                                </p>
                                            </Box>
                                        )}
                                    </aside>
                                </Reveal>
                            </div>

                            <AnimatePresence>
                                {note !== null && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                                        className="shell pb-8"
                                    >
                                        <div
                                            role={note.tone === "stop" ? "alert" : "status"}
                                            className={`rounded-card border p-5 ${
                                                note.tone === "stop" ? "border-flag bg-flag/[0.08]" : "border-line bg-surface"
                                            }`}
                                        >
                                            <h3 className={`text-base font-semibold ${note.tone === "stop" ? "text-flag" : ""}`}>
                                                {note.title}
                                            </h3>
                                            <ul className="mt-2 grid list-disc gap-1 pl-5 text-[0.9375rem] text-dim">
                                                {note.lines.map((l) => <li key={l}>{l}</li>)}
                                            </ul>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </section>

                        {proposal !== null && (
                            <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
                                <div className="shell grid items-start gap-10 lg:grid-cols-[1fr_17rem]">
                                    <div className="min-w-0">
                                        <Reveal>
                                            <div className="mb-4 flex items-baseline gap-3.5">
                                                <h2 className="text-xl font-semibold tracking-[-0.02em]">
                                                    What each amount is standing on
                                                </h2>
                                                <span className="rounded-full border border-dashed border-line px-2.5 py-1 font-mono text-[0.6875rem] text-dim">
                                                    {count(proposal.legs.length, "leg")}
                                                </span>
                                            </div>
                                            <p className="measure mb-5">
                                                One row per leg, with every claim the agent used and every quote under it.
                                                A fact with no verbatim quote never reached this page.
                                            </p>
                                        </Reveal>
                                        <div className="border-t border-line">
                                            {proposal.legs.map((leg, i) => {
                                                const theme = brief?.themes.find((t) => t.themeId === leg.theme);
                                                const fit = theme?.fits.find((f) => f.symbol === leg.symbol);
                                                return (
                                                    <LegRow
                                                        key={`${leg.theme}:${leg.symbol}:${i}`}
                                                        symbol={leg.symbol}
                                                        theme={leg.theme}
                                                        amount={formatUsdc(leg.usdcIn)}
                                                        defaultOpen={i === 0}
                                                    >
                                                        {fit === undefined ? (
                                                            <p className="pb-6 text-sm text-flag">
                                                                This leg's theme is not in the brief the desk is holding, so its
                                                                evidence cannot be shown here. The allocation was still checked
                                                                against the mandate.
                                                            </p>
                                                        ) : (
                                                            <EvidenceBody fit={fit} claims={claimsById} sources={sourcesById} />
                                                        )}
                                                    </LegRow>
                                                );
                                            })}
                                        </div>

                                        {fills !== null && (
                                            <div className={`mt-8 rounded-card border p-5 ${fills.simulated ? "border-line bg-surface" : "border-amber bg-amber/[0.07]"}`}>
                                                <h3 className={`text-base font-semibold ${fills.simulated ? "" : "text-amber"}`}>
                                                    {fills.simulated ? "Simulated fills, no token moved" : "Fills, onchain"}
                                                </h3>
                                                <div className="mt-3 border-t border-line">
                                                    {fills.fills.map((f) => (
                                                        <div key={f.symbol + f.quantity} className="flex items-baseline gap-4 border-b border-line py-3 font-mono text-sm">
                                                            <span className="min-w-[5rem] text-ink">{f.symbol}</span>
                                                            <span className="flex-1 text-dim">{f.quantity} units at {f.price}</span>
                                                            <span className="text-ink">{formatUsdc(f.usdcIn)}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <aside className="grid gap-4 lg:sticky lg:top-24">
                                        <Box title="Swaps the agent will send">
                                            <ul className="m-0 grid list-none gap-2.5 p-0 font-mono text-xs">
                                                {proposal.swaps.map((s) => (
                                                    <li key={s.symbol} className="grid gap-0.5">
                                                        <span className="text-ink">{s.symbol} · {formatUsdc(s.usdcIn)} USDC</span>
                                                        <span className="text-[0.6875rem] text-dim">{s.parts.map((p) => p.theme).join(", ")}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                            <p className="mt-3 text-xs text-dim">
                                                Legs buying the same token merge into one swap, so gas is paid once. The book
                                                still records one entry per theme.
                                            </p>
                                        </Box>
                                        <Box title="What a quote proves"><WhatAQuoteProves /></Box>
                                    </aside>
                                </div>
                            </section>
                        )}
                    </>
                )}

                {tab === "mandate" && mandate !== null && (
                    <MandatePanel mandate={mandate} onSaved={(m) => setMandate(m)} />
                )}
                {tab === "mandate" && mandate === null && (
                    <div className="shell py-16"><p className="font-mono text-sm text-dim" role="status">Reading the mandate…</p></div>
                )}

                {tab === "book" && <TheBook ledger={ledger} positions={positions} />}
            </main>

            <Footer>
                <span>Signed in as {address}</span>
                <span>Research is informational and is not investment advice.</span>
                <span>Simulated fills move no tokens and are tagged sim in the book.</span>
            </Footer>
        </>
    );
}

function DeskLink({ to, current, children }: { to: string; current: boolean; children: React.ReactNode }) {
    return (
        <a
            href={to}
            aria-current={current ? "page" : undefined}
            onClick={(e) => { e.preventDefault(); navigate(to); }}
            className={`relative py-0.5 text-sm no-underline transition-colors after:absolute after:bottom-0 after:left-0 after:h-px after:bg-lime after:transition-[width] after:duration-300 hover:text-ink ${
                current ? "text-ink after:w-full" : "after:w-0 hover:after:w-full"
            }`}
        >
            {children}
        </a>
    );
}

/**
 * Where the owner is in the one sequence that matters.
 *
 * `blocked` is drawn differently from `later` on purpose: "you cannot propose yet" and "you will
 * propose next" look the same in a progress bar and mean completely different things to someone
 * waiting.
 */
function StepRail({ states }: { states: StepState[] }) {
    const still = useReducedMotion() === true;
    return (
        <nav aria-label="Where you are" className="border-b border-line">
            <ol className="shell flex list-none flex-wrap gap-x-7 gap-y-2 py-3.5">
                {STEPS.map((name, i) => {
                    const s = states[i]!;
                    return (
                        <li key={name} aria-current={s === "now" ? "step" : undefined} className="flex items-center gap-2 text-sm">
                            <motion.span
                                className={`grid size-6 place-items-center rounded-[4px] font-mono text-[0.6875rem] font-bold ${
                                    s === "now"
                                        ? "bg-lime text-lime-ink"
                                        : s === "done"
                                            ? "bg-lime/15 text-lime"
                                            : s === "blocked"
                                                ? "border border-dashed border-flag text-flag"
                                                : "bg-pill text-dim"
                                }`}
                                animate={still ? undefined : { scale: s === "now" ? 1.06 : 1 }}
                                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                            >
                                {i + 1}
                            </motion.span>
                            <span className={s === "now" ? "font-semibold text-ink" : s === "later" ? "text-dim opacity-60" : "text-dim"}>
                                {name}
                            </span>
                            <span className="sr-only">{describeState(s)}</span>
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

function Actions(p: {
    proposal: Proposal | null;
    fills: ExecuteResult | null;
    busy: Busy;
    loading: boolean;
    expired: boolean;
    investable: string;
    realSwaps: boolean;
    onSync: () => void;
    onPropose: () => void;
    onApprove: () => void;
    onExecute: () => void;
    onReset: () => void;
}) {
    if (p.fills !== null) {
        return <Button onClick={p.onReset}>Start another <span aria-hidden="true">↗</span></Button>;
    }
    if (p.proposal === null) {
        return (
            <>
                <Button onClick={p.onSync} disabled={p.busy !== null || p.loading}>
                    {p.busy === "sync" ? "Reading the books…" : "Sync revenue and costs"} <span aria-hidden="true">↗</span>
                </Button>
                <button
                    type="button"
                    onClick={p.onPropose}
                    disabled={p.busy !== null || p.loading || BigInt(p.investable) <= 0n}
                    className="border-0 bg-transparent py-2 text-sm text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-45"
                >
                    {p.busy === "propose" ? "Quoting…" : "Request a proposal"}
                </button>
            </>
        );
    }
    if (p.proposal.state === "PROPOSED" || p.expired) {
        return (
            <>
                <Button onClick={p.onApprove} disabled={p.busy !== null}>
                    {p.busy === "approve" ? "Waiting for your wallet…" : p.expired ? "Sign again" : "Sign this proposal"}
                    <span aria-hidden="true">↗</span>
                </Button>
                <Quiet onClick={p.onReset} disabled={p.busy !== null}>Refuse and discard it</Quiet>
            </>
        );
    }
    if (p.proposal.state === "APPROVED") {
        return (
            <>
                <Button onClick={p.onExecute} disabled={p.busy !== null}>
                    {p.busy === "execute" ? "Re-quoting and filling…" : p.realSwaps ? "Execute with real money" : "Execute, simulated"}
                    <span aria-hidden="true">↗</span>
                </Button>
                <Quiet onClick={p.onReset} disabled={p.busy !== null}>Discard it</Quiet>
            </>
        );
    }
    return <Button onClick={p.onReset}>Start another <span aria-hidden="true">↗</span></Button>;
}

function Quiet({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="border-0 bg-transparent py-2 text-sm text-dim underline decoration-transparent underline-offset-4 transition-colors hover:text-ink hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-45"
        >
            {children}
        </button>
    );
}

function Box({ title, children, alarm }: { title: string; children: React.ReactNode; alarm?: boolean }) {
    return (
        <div className={`rounded-card border p-4 ${alarm === true ? "border-flag bg-flag/[0.07]" : "border-line bg-surface"}`}>
            <h3 className="mb-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-dim">{title}</h3>
            {children}
        </div>
    );
}

function Figures({ rows }: { rows: [string, string][] }) {
    return (
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
            {rows.map(([k, v]) => (
                <div key={k} className="grid gap-0.5">
                    <dt className="font-mono text-[0.6875rem] uppercase tracking-[0.05em] text-dim">{k}</dt>
                    <dd className="num m-0 text-[1.0625rem] font-semibold text-ink">{v}</dd>
                </div>
            ))}
        </dl>
    );
}

function LegRow({
    symbol, theme, amount, defaultOpen, children,
}: {
    symbol: string; theme: string; amount: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen === true);
    const still = useReducedMotion() === true;
    return (
        <div className="border-b border-line">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="group relative flex w-full items-center gap-4 border-0 bg-transparent py-4 text-left"
            >
                <span
                    aria-hidden="true"
                    className={`absolute -left-4 top-0 h-full w-0.5 origin-top bg-lime transition-transform duration-300 ${open ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"}`}
                />
                <span className="min-w-[5rem] font-mono text-sm text-ink">{symbol}</span>
                <span className="flex-1 text-[0.9375rem] text-dim">{theme}</span>
                <span className="num min-w-[7rem] text-right font-medium text-ink">{amount}</span>
                <motion.span aria-hidden="true" className="text-xs text-dim" animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.3 }}>▾</motion.span>
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
                        <div className="overflow-hidden">{children}</div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function TheBook({ ledger, positions }: { ledger: InvestLedger | null; positions: PositionsView | null }) {
    return (
        <section className="py-[clamp(2.5rem,5vw,3.5rem)]">
            <div className="shell">
                <Reveal>
                    <div className="mb-4 flex items-baseline gap-3.5">
                        <h1 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium tracking-[-0.035em]">The book</h1>
                        <span className="rounded-full border border-dashed border-line px-2.5 py-1 font-mono text-[0.6875rem] text-dim">
                            {count(ledger?.entries.length ?? 0, "entry", "entries")}
                        </span>
                    </div>
                    <p className="measure mb-6">
                        Double-entry, append-only, and tagged with the mode it happened in. Nothing here is ever
                        rewritten.
                    </p>
                </Reveal>

                {positions !== null && <AgainstTheChain positions={positions} />}

                <div className="mt-6 border-t border-line">
                    {(ledger?.entries ?? []).map((e, i) => {
                        const cash = e.lines.find((l) => l.account === "cash.operating");
                        return (
                            <Reveal key={e.id} delay={Math.min(i, 8) * 0.03}>
                                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-3.5">
                                    <span className="min-w-[11rem] font-mono text-sm text-ink">
                                        {e.type.replace(/_/g, " ").toLowerCase()}
                                    </span>
                                    <span className="flex-1 text-sm text-dim">{e.briefId ?? e.memo ?? ""}</span>
                                    <span className={`rounded-full px-2.5 py-1 font-mono text-[0.6875rem] ${
                                        e.mode === "sim" ? "border border-dashed border-line text-faint" : "border border-line bg-pill text-dim"
                                    }`}>
                                        {e.mode}
                                    </span>
                                    <span className="num min-w-[7rem] text-right text-ink">
                                        {cash === undefined ? "" : formatUsdc(cash.amount)}
                                    </span>
                                </div>
                            </Reveal>
                        );
                    })}
                    {(ledger?.entries.length ?? 0) === 0 && (
                        <p className="py-6 text-sm text-dim">
                            Nothing booked yet. Sync once a brief has sold and the first entries appear here.
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
}

function describeState(s: StepState): string {
    if (s === "done") return "done";
    if (s === "now") return "current step";
    if (s === "next") return "next";
    if (s === "blocked") return "not possible yet";
    return "later";
}

function labelFor(what: Busy): string {
    if (what === "sync") return "Could not sync revenue";
    if (what === "propose") return "Nothing was proposed";
    if (what === "approve") return "Not approved, and nothing was sent";
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
 * Reconciliation says the books agree with themselves. This says whether they are true, which is a
 * different question and the only one a holder of the tokens actually cares about.
 */
function AgainstTheChain({ positions }: { positions: PositionsView }) {
    if (!positions.checked) {
        return <p className="text-sm text-dim">Against the chain: nothing to compare. {positions.why ?? "Fills are simulated."}</p>;
    }
    if (positions.positions.length === 0) {
        return <p className="text-sm text-dim">Against the chain: nothing bought yet, so nothing to hold.</p>;
    }
    return (
        <div className={`rounded-card border p-5 ${positions.ok === false ? "border-flag bg-flag/[0.08]" : "border-line bg-surface"}`}>
            <h3 className={`text-base font-semibold ${positions.ok === false ? "text-flag" : ""}`}>
                {positions.ok === false ? "The wallet does not hold what the books say." : "The wallet holds what the books say."}
            </h3>
            <div className="mt-3 border-t border-line">
                {positions.positions.map((p) => (
                    <div key={p.asset} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-3 text-sm">
                        <span className="min-w-[5rem] font-mono text-ink">{p.symbol}</span>
                        <span className="flex-1 text-dim">
                            booked {p.bookedUnits} units, wallet holds {p.heldUnits}
                            {p.verdict === "matches" ? "" : ` (${p.verdict}, ${p.differenceUnits})`}
                        </span>
                        <span className={`rounded-full px-2.5 py-1 font-mono text-[0.6875rem] ${
                            p.verdict === "matches" ? "border border-line bg-pill text-lime" : "border border-dashed border-flag text-flag"
                        }`}>
                            {p.verdict}
                        </span>
                    </div>
                ))}
            </div>
            {positions.issues.map((i) => <p className="mt-3 text-sm text-flag" key={i}>{i}</p>)}
        </div>
    );
}

/**
 * What executing would really do, said before the button is pressed rather than after.
 *
 * The distinction is the whole difference between a rehearsal and spending money, and it cannot be
 * read off the configuration: mainnet with no key still simulates. So the agent is asked, and what it
 * answers is what is shown. Amber, never lime: lime is for things that went right.
 */
function RealMoneyNotice({ execution }: { execution: ExecutionStatus }) {
    const real = execution.willSendRealSwaps;
    return (
        <div className={`measure mt-6 rounded-[10px] border p-4 ${real ? "border-amber bg-amber/[0.08]" : "border-line bg-surface"}`}>
            <p className="m-0 text-sm">
                <strong className={real ? "text-amber" : "text-ink"}>
                    {real ? "Executing will spend real money." : "Executing is simulated."}
                </strong>{" "}
                {real
                    ? `Swaps are sent from ${execution.address ?? "the execution wallet"} on Base mainnet.`
                    : execution.why ?? "No token moves, and the book is tagged sim."}
            </p>
            {real && execution.remainingUsdcMinor !== undefined && (
                <p className="mt-2 text-xs text-dim">
                    {formatUsdc(execution.remainingUsdcMinor)} USDC of the spend cap is left,{" "}
                    {formatUsdc(execution.spentUsdcMinor ?? "0")} already committed.
                </p>
            )}
        </div>
    );
}

function headline(p: Proposal | null, investable: string, expired: boolean): string {
    if (expired) return "That signature has expired.";
    if (p === null) return BigInt(investable) > 0n ? "There is surplus to put to work." : "Nothing moves until you sign.";
    if (p.state === "PROPOSED") return `The agent wants to buy ${count(p.legs.length, "position")}.`;
    if (p.state === "APPROVED") return "Signed. Execute when you are ready.";
    return "Done. The book has been written.";
}

function subhead(p: Proposal | null, investable: string, sync: SyncResult | null, expired: boolean): string {
    if (expired) {
        return "The price moved on, or the clock ran out, so the approval no longer binds. Nothing was sent. Read it again and sign if you still want it.";
    }
    if (p !== null) {
        if (p.state === "PROPOSED") {
            return "Every amount below carries the claims and filing sentences it came from. Read them, then sign the exact payload the agent offered.";
        }
        if (p.state === "APPROVED") {
            return "Your signature covers this proposal, this mandate version and a spending ceiling. Executing re-quotes first and stops if the price has drifted too far.";
        }
        return "The fills are below and the entries are in the book.";
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
