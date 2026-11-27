import { useEffect, useState } from "react";
import { Reveal } from "./motion";
import { api, ApiError, formatUsdc, type Holding, type Holdings } from "./api";
import { explorerTokenBalance, explorerTx, shortHash } from "./explorer";

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

/**
 * What the agent holds, per token, in whole tokens and dollars.
 *
 * The books are the source, and they say plainly when the fills were simulated: then nothing is in any
 * wallet, and the value is what the committed units would sell for, not money anyone has. The live
 * value is asked for because it costs one quote per token held.
 */
export function HoldingsPanel({ wallet }: { wallet: string | undefined }) {
    const [data, setData] = useState<Holdings | null>(null);
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
                        <div className="mt-4 overflow-x-auto">
                            <table className="w-full min-w-[36rem] border-collapse text-sm">
                                <thead>
                                    <tr className="border-b border-line text-left text-[0.8125rem] text-dim">
                                        <th scope="col" className="py-2 pr-4 font-normal">Token</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Quantity</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Cost, USDC</th>
                                        <th scope="col" className="py-2 pr-4 text-right font-normal">Value, USDC</th>
                                        <th scope="col" className="py-2 text-right font-normal">Change</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((h) => <Row key={h.asset} h={h} valued={valued} wallet={links ? wallet : undefined} />)}
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
            </div>
        </Reveal>
    );
}

function Row({ h, valued, wallet }: { h: Holding; valued: boolean; wallet: string | undefined }) {
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
            <td className={`num py-3 text-right font-mono ${c === null ? "" : c.usdc < 0n ? "text-flag" : c.usdc > 0n ? "text-lime" : ""}`}>
                {c === null ? "" : changeWords(c)}
            </td>
        </tr>
    );
}
