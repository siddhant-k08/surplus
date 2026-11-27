import { useEffect, useState } from "react";
import { Reveal } from "./motion";
import { Button } from "./Chrome";
import { api, ApiError, formatUsdc, type ExecuteResult, type ExitProposal, type Holding, type Holdings } from "./api";
import { explorerTokenBalance, explorerTx, shortHash } from "./explorer";
import { currentAccount, describeWalletError, ensureChain, signTypedData } from "./wallet";

/** Base mainnet, where the tokenized stocks exist. A real fill can only have happened there. */
const BASE = "eip155:8453";

/**
 * Token minor units as whole tokens, exact, with trailing zeros dropped.
 *
 * Integer arithmetic throughout: a position is a count of units, and a float would print a quantity
 * the wallet does not hold. Null decimals means the token list could not be read, so the raw count is
 * shown and labelled rather than guessed at.
 */
export function formatUnits(units: string, decimals: number | null): string {
    if (decimals === null) return `${units} units`;
    const v = BigInt(units);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = decimals === 0 ? "" : (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}

/** Value against cost, in USDC minor units and basis points. Null when either is missing. */
export function change(h: Pick<Holding, "valueUsdcMinor" | "costUsdcMinor">): { usdc: bigint; bps: number } | null {
    if (h.valueUsdcMinor === undefined || h.valueUsdcMinor === null) return null;
    const cost = BigInt(h.costUsdcMinor);
    if (cost <= 0n) return null;
    const usdc = BigInt(h.valueUsdcMinor) - cost;
    return { usdc, bps: Number((usdc * 10_000n) / cost) };
}

/** A signed USDC amount and percentage, as a person reads a gain or a loss. */
export function changeWords(c: { usdc: bigint; bps: number }): string {
    const sign = c.usdc > 0n ? "+" : c.usdc < 0n ? "-" : "";
    const abs = c.usdc < 0n ? -c.usdc : c.usdc;
    return `${sign}${formatUsdc(abs)} (${sign}${(Math.abs(c.bps) / 100).toFixed(2)}%)`;
}

/** Open positions first, largest cost first; closed ones after, so a round trip stays visible. */
export function ordered(positions: readonly Holding[]): Holding[] {
    const open = (h: Holding) => BigInt(h.units) > 0n;
    return [...positions].sort((a, b) => {
        if (open(a) !== open(b)) return open(a) ? -1 : 1;
        const d = BigInt(b.costUsdcMinor) - BigInt(a.costUsdcMinor);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
    });
}

/** What a sale proposal adds up to: value at the quote, cost basis, and the difference. */
export function saleTotals(selling: ExitProposal["selling"]): { value: bigint; cost: bigint; gain: bigint } {
    const value = selling.reduce((a, c) => a + BigInt(c.valueUsdcMinor), 0n);
    const cost = selling.reduce((a, c) => a + BigInt(c.costUsdcMinor), 0n);
    return { value, cost, gain: value - cost };
}

/** A gain or a loss in words, never a bare signed number. */
export function gainWords(gain: bigint): string {
    if (gain === 0n) return "no gain or loss";
    return `a ${gain > 0n ? "gain" : "loss"} of ${formatUsdc(gain < 0n ? -gain : gain)} USDC`;
}

/** Where a sale has got to. Each step is its own request, and only the last moves anything. */
interface Sale {
    proposal: ExitProposal;
    stage: "proposed" | "approved" | "done";
    expiresAt?: string;
    result?: ExecuteResult;
}

type SaleBusy = null | "propose" | "approve" | "execute";

/**
 * What the agent holds, per token, in whole tokens and dollars.
 *
 * The books are the source, and they say plainly when the fills were simulated: then nothing is in any
 * wallet, and the value is what the committed units would sell for, not money anyone has. The live
 * value is asked for because it costs one quote per token held.
 */
export function HoldingsPanel({ wallet, owner, real, onChanged }: {
    wallet: string | undefined;
    /** The signed-in owner, who signs a sale exactly as they sign a purchase. */
    owner: string;
    /** Whether executing sends real swaps. Asked of the agent, never inferred here. */
    real: boolean;
    onChanged: () => Promise<void>;
}) {
    const [data, setData] = useState<Holdings | null>(null);
    const [sale, setSale] = useState<Sale | null>(null);
    const [saleBusy, setSaleBusy] = useState<SaleBusy>(null);
    const [saleError, setSaleError] = useState<string | null>(null);
    const [state, setState] = useState<"loading" | "idle" | "valuing" | "failed">("loading");
    const [why, setWhy] = useState("");

    async function load(live: boolean) {
        setState(live ? "valuing" : "loading");
        setWhy("");
        try {
            setData(await api.holdings(live));
            setState("idle");
        } catch (e) {
            setState("failed");
            setWhy(e instanceof ApiError && e.reasons.length > 0
                ? e.reasons.join(", ")
                : e instanceof Error ? e.message : String(e));
        }
    }

    useEffect(() => {
        void load(false);
    }, []);

    async function step(what: Exclude<SaleBusy, null>, fn: () => Promise<void>) {
        setSaleBusy(what);
        setSaleError(null);
        try {
            await fn();
        } catch (e) {
            setSaleError(e instanceof ApiError && e.reasons.length > 0 ? e.reasons.join("; ") : describeWalletError(e));
        } finally {
            setSaleBusy(null);
        }
    }

    /** Proposing moves nothing: it quotes the sale and returns what the owner would sign. */
    const propose = (h: Holding) =>
        step("propose", async () => {
            setSale({ proposal: await api.exit([{ asset: h.asset }]), stage: "proposed" });
        });

    const approve = () =>
        step("approve", async () => {
            if (sale === null) return;
            // Same guard as a purchase: a wallet that has switched accounts would sign as someone else.
            const selected = currentAccount();
            if (selected !== null && selected.toLowerCase() !== owner.toLowerCase()) {
                throw new Error(
                    `Your wallet has switched to ${selected}, but this session is signed in as ${owner}. ` +
                    "Switch back to that account, or sign out and sign in again.",
                );
            }
            await ensureChain((sale.proposal.toSign as { domain: { chainId: number } }).domain.chainId);
            const signature = await signTypedData(owner, sale.proposal.toSign);
            const r = await api.approve(sale.proposal.id, signature);
            setSale({ ...sale, stage: "approved", expiresAt: r.expiresAt });
        });

    const execute = () =>
        step("execute", async () => {
            if (sale === null) return;
            const result = await api.execute(sale.proposal.id);
            setSale({ ...sale, stage: "done", result });
            await load(false);
            await onChanged();
        });

    const rows = ordered(data?.positions ?? []);
    const valued = data?.valuedAt !== undefined;
    const open = rows.filter((h) => BigInt(h.units) > 0n);
    const cost = open.reduce((a, h) => a + BigInt(h.costUsdcMinor), 0n);
    const value = valued && open.every((h) => typeof h.valueUsdcMinor === "string")
        ? open.reduce((a, h) => a + BigInt(h.valueUsdcMinor!), 0n)
        : null;
    const realized = data === null ? 0n : BigInt(data.realizedUsdcMinor);
    const links = data !== null && !data.simulated && wallet !== undefined;

    return (
        <Reveal>
            <div className="rounded-card border border-line bg-surface p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h2 className="text-base font-semibold">What the agent holds</h2>
                    {rows.length > 0 && (
                        <button type="button" onClick={() => void load(true)} disabled={state === "valuing" || state === "loading"}
                            className="border-0 bg-transparent py-1 text-sm text-dim underline decoration-transparent underline-offset-4 transition-colors hover:text-ink hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-45">
                            {state === "valuing" ? "Reading live quotes…" : valued ? "Value again" : "Value at live quotes"}
                        </button>
                    )}
                </div>

                {data?.simulated === true && rows.length > 0 && (
                    <p className="mt-2 text-sm text-amber">
                        Simulated fills. These are the units the agent committed on its books; no token was
                        bought and no wallet holds them.
                    </p>
                )}
                {links && (
                    <p className="mt-2 text-sm text-dim">
                        Held in the trading wallet{" "}
                        <a className="font-mono text-ink underline underline-offset-4" href={`https://basescan.org/address/${wallet}`}
                            target="_blank" rel="noreferrer" title={wallet}>{shortHash(wallet!, 6, 4)}</a>
                        , not the owner's wallet.
                    </p>
                )}

                {state === "loading" && <p className="mt-3 font-mono text-sm text-dim" role="status">Reading the books…</p>}
                {state === "failed" && (
                    <p className="mt-3 text-sm text-flag" role="alert">
                        {valued || data !== null ? "The live value could not be read" : "The holdings could not be read"}: {why}.
                    </p>
                )}
                {data !== null && rows.length === 0 && (
                    <p className="mt-3 text-sm text-dim">Nothing bought yet. A position appears here after the first fill.</p>
                )}

                {rows.length > 0 && (
                    <div aria-live="polite">
                        <div className="relative mt-4 overflow-x-auto">
                            <table className="w-full min-w-[36rem] border-collapse text-sm">
                                <thead>
                                    <tr className="border-b border-line text-left text-[0.8125rem] text-dim">
                                        <th scope="col" className="py-2 pr-4 font-normal">Token</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Quantity</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Cost, USDC</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Value, USDC</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Change</th>
                                        <th scope="col" className="py-2 text-right font-normal"><span className="sr-only">Sell</span></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((h) => (
                                        <Row
                                            key={h.asset} h={h} valued={valued} wallet={links ? wallet : undefined}
                                            onSell={sale === null || sale.stage === "done" ? () => void propose(h) : undefined}
                                            selling={saleBusy === "propose"}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="mt-4 text-[0.8125rem] leading-relaxed text-dim">
                            {formatUsdc(cost)} USDC paid for what is held
                            {value !== null && <>, worth {formatUsdc(value)} USDC by live sell quotes before gas</>}
                            {realized !== 0n && (
                                <>, and a realized {realized > 0n ? "gain" : "loss"} of {formatUsdc(realized < 0n ? -realized : realized)} USDC from sales</>
                            )}.
                            {valued && data?.valuedAt !== undefined && <> Quoted at {new Date(data.valuedAt).toLocaleTimeString()}.</>}
                        </p>
                    </div>
                )}

                {saleError !== null && sale === null && (
                    <p className="mt-4 text-sm text-flag" role="alert">Nothing was proposed: {saleError}</p>
                )}
                {sale !== null && (
                    <SalePanel
                        sale={sale} busy={saleBusy} error={saleError} real={real} wallet={wallet}
                        decimals={new Map(rows.map((h) => [h.asset.toLowerCase(), h.decimals]))}
                        onApprove={() => void approve()} onExecute={() => void execute()}
                        onClose={() => { setSale(null); setSaleError(null); }}
                    />
                )}
            </div>
        </Reveal>
    );
}

function Row({ h, valued, wallet, onSell, selling }: {
    h: Holding;
    valued: boolean;
    wallet: string | undefined;
    /** Absent while another sale is in progress. */
    onSell: (() => void) | undefined;
    selling: boolean;
}) {
    const closed = BigInt(h.units) === 0n;
    const c = change(h);
    const balance = wallet === undefined ? null : explorerTokenBalance(BASE, h.asset, wallet);
    return (
        <tr className={`border-b border-line align-baseline ${closed ? "text-dim" : ""}`}>
            <th scope="row" className="py-3 pr-4 text-left font-normal">
                <span className="font-mono text-ink">{h.symbol ?? shortHash(h.asset, 6, 4)}</span>
                {closed && <span className="ml-2 text-[0.75rem] text-dim">closed</span>}
                {(balance !== null || h.transactions.length > 0) && (
                    <span className="mt-1 flex flex-wrap gap-x-3 text-[0.75rem]">
                        {balance !== null && (
                            <a className="text-dim underline underline-offset-4 hover:text-ink" href={balance.url} target="_blank" rel="noreferrer">
                                balance on {balance.name}
                            </a>
                        )}
                        {h.transactions.map((t) => {
                            const link = explorerTx(BASE, t);
                            return link === null ? null : (
                                <a key={t} className="font-mono text-dim underline underline-offset-4 hover:text-ink" href={link.url}
                                    target="_blank" rel="noreferrer" title={t}>{shortHash(t, 6, 4)}</a>
                            );
                        })}
                    </span>
                )}
            </th>
            <td className="num py-3 pr-4 text-right font-mono">{formatUnits(h.units, h.decimals)}</td>
            <td className="num py-3 pr-4 text-right font-mono">{formatUsdc(h.costUsdcMinor)}</td>
            <td className="num py-3 pr-4 text-right font-mono">
                {closed ? "" : !valued ? <span className="text-dim">not read</span>
                    : h.valueUsdcMinor === null || h.valueUsdcMinor === undefined
                        ? <span className="text-flag" title={h.valueError ?? undefined}>no quote</span>
                        : formatUsdc(h.valueUsdcMinor)}
            </td>
            <td className={`num py-3 pr-4 text-right font-mono ${c === null ? "" : c.usdc < 0n ? "text-flag" : c.usdc > 0n ? "text-lime" : ""}`}>
                {c === null ? "" : changeWords(c)}
            </td>
            <td className="py-3 text-right">
                {!closed && (
                    <button
                        type="button"
                        onClick={onSell}
                        disabled={onSell === undefined || selling || !h.sellable}
                        title={h.sellable ? `Propose selling all ${h.symbol ?? "of this token"}` : h.why ?? "cannot be sold"}
                        className="rounded-[4px] border-0 bg-transparent px-2.5 py-1.5 text-sm text-ink shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--color-lime)] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        {selling ? "Quoting…" : "Sell"}
                    </button>
                )}
            </td>
        </tr>
    );
}

/**
 * A sale, from proposal to fill, with the owner's signature in the middle.
 *
 * Proposing and signing move nothing. Only the last button does, and it says whether that is real
 * money before it is pressed. The amounts are the sell quote at proposal time: execution re-quotes, and
 * a price that has moved past the mandate's drift tolerance stops it for a new signature.
 */
function SalePanel({ sale, busy, error, real, wallet, decimals, onApprove, onExecute, onClose }: {
    sale: Sale;
    busy: SaleBusy;
    error: string | null;
    real: boolean;
    wallet: string | undefined;
    decimals: ReadonlyMap<string, number | null>;
    onApprove: () => void;
    onExecute: () => void;
    onClose: () => void;
}) {
    const p = sale.proposal;
    const t = saleTotals(p.selling);
    const expired = sale.expiresAt !== undefined && Date.parse(sale.expiresAt) <= Date.now() && sale.stage === "approved";
    const sold = sale.result?.fills.filter((f) => f.side === "sell") ?? [];
    const proceeds = sold.reduce((a, f) => a + BigInt(f.proceedsUsdc ?? "0"), 0n);
    const realized = sold.reduce((a, f) => a + BigInt(f.realizedUsdc ?? "0"), 0n);

    return (
        <div className={`mt-5 min-w-0 rounded-card border p-5 [overflow-wrap:anywhere] ${real && sale.stage !== "done" ? "border-amber bg-amber/[0.07]" : "border-line"}`}
            aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-base font-semibold">
                    {sale.stage === "done"
                        ? sale.result?.simulated === false ? "Sold, onchain" : "Sold, simulated"
                        : "Sale proposal"}
                </h3>
                <button type="button" onClick={onClose} disabled={busy !== null}
                    className="border-0 bg-transparent py-1 text-sm text-dim underline decoration-transparent underline-offset-4 hover:text-ink hover:decoration-ink disabled:opacity-45">
                    {sale.stage === "done" ? "Close" : "Discard"}
                </button>
            </div>

            <ul className="mt-3 grid list-none gap-1.5 p-0 text-sm">
                {p.selling.map((c) => (
                    <li key={`${c.asset}:${c.theme}`}>
                        <span className="font-mono text-ink">{c.symbol}</span>{" "}
                        <span className="text-dim">
                            {formatUnits(c.units, decimals.get(c.asset.toLowerCase()) ?? null)} under {c.theme}: worth{" "}
                            {formatUsdc(c.valueUsdcMinor)} USDC at the quote, against a cost of {formatUsdc(c.costUsdcMinor)}
                        </span>
                        {c.caveat !== null && <span className="block text-amber">{c.caveat}</span>}
                    </li>
                ))}
            </ul>

            {sale.stage !== "done" && (
                <>
                    <p className="mt-3 text-sm text-dim">
                        About {formatUsdc(t.value)} USDC back, {gainWords(t.gain)} before gas. The sale is re-quoted when
                        it executes, and stops for a new signature if the price has moved past your drift tolerance.
                    </p>
                    {[...p.warnings, ...p.skipped.map((x) => `${x.symbol} not sold: ${x.why}`)].map((w) => (
                        <p key={w} className="mt-2 text-sm text-amber">{w}</p>
                    ))}
                    <p className={`mt-3 text-sm ${real ? "text-amber" : "text-dim"}`}>
                        {real
                            ? `Executing sends real transactions from the trading wallet${wallet === undefined ? "" : ` ${shortHash(wallet, 6, 4)}`}: an approval of exactly these tokens, then the swap. Neither can be undone.`
                            : "Executing is simulated: no token moves, and the book is tagged sim."}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        {sale.stage === "proposed" && (
                            <Button onClick={onApprove} disabled={busy !== null}>
                                {busy === "approve" ? "Waiting for your wallet…" : "Sign to approve the sale"}
                            </Button>
                        )}
                        {sale.stage === "approved" && (
                            <Button onClick={onExecute} disabled={busy !== null || expired}>
                                {busy === "execute" ? "Re-quoting and selling…" : real ? "Sell with real money" : "Sell, simulated"}
                            </Button>
                        )}
                        {sale.stage === "approved" && sale.expiresAt !== undefined && (
                            <span className={`text-xs ${expired ? "text-flag" : "text-dim"}`}>
                                {expired
                                    ? "The approval has expired. Discard and sell again for a fresh quote."
                                    : `Approved until ${new Date(sale.expiresAt).toLocaleTimeString()}.`}
                            </span>
                        )}
                    </div>
                </>
            )}

            {sale.stage === "done" && sale.result !== undefined && (
                <div className="mt-3 grid gap-2 text-sm">
                    {sold.length > 0 && (
                        <p className="m-0 text-ink">
                            {formatUsdc(proceeds)} USDC came back, {gainWords(realized)}. It returns to the investable
                            balance, not to operating cash, so it is not swept into the reserve again.
                        </p>
                    )}
                    {(sale.result.unfilled ?? []).map((u) => (
                        <p key={u.symbol} className="m-0 text-flag">{u.symbol} was not sold: {u.reason}.</p>
                    ))}
                    {sale.result.warnings.map((w) => <p key={w} className="m-0 text-amber">{w}</p>)}
                    {sale.result.simulated === false && (
                        <p className="m-0 text-dim">The transaction is listed under the token above, and the books are checked against the wallet below.</p>
                    )}
                </div>
            )}

            {error !== null && <p className="mt-3 text-sm text-flag" role="alert">{error}</p>}
        </div>
    );
}
