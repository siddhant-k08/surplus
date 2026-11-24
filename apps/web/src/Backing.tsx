import { useEffect, useState } from "react";
import { Note, Spine } from "./Chrome";
import { MaskedLine, Reveal, motion, riseItem, stagger } from "./motion";
import { backing, formatUsdc, type Backing, type BriefBacking } from "./api";

/**
 * What the agent has put behind its own research.
 *
 * Everything else on this site is checkable from the brief itself: a claim cites a filing, the quote is
 * in the filing, the numbers are in the quote. This is the one claim a brief cannot prove about itself,
 * that the agent spends the money the research earned on the companies the research points at. So it
 * comes from a public route, with the token addresses and transactions in it, and a reader who does not
 * believe the page can go and look.
 *
 * The honesty rule here is the verb. While fills are simulated nothing has been bought, and a surface
 * that says "holds" would be describing a position that does not exist. `verb` and `SimulatedNote`
 * exist so that no caller has to remember which case it is in.
 */

type Load = { k: "loading" } | { k: "ready"; backing: Backing } | { k: "down" };

export function useBacking(): Load {
    const [load, setLoad] = useState<Load>({ k: "loading" });
    useEffect(() => {
        backing()
            .then((b) => setLoad({ k: "ready", backing: b }))
            .catch(() => setLoad({ k: "down" }));
    }, []);
    return load;
}

/** What one brief's positions came to, or null when the agent has not acted on it. */
export function forBrief(b: Backing | null, briefId: string): BriefBacking | null {
    return b?.briefs.find((x) => x.briefId === briefId) ?? null;
}

/** What one theme of one brief came to, in USDC minor units. Null when that theme got nothing. */
export function themeStake(brief: BriefBacking | null, themeId: string): string | null {
    return brief?.themes.find((t) => t.theme === themeId)?.usdcMinor ?? null;
}

/**
 * What one company got under one theme.
 *
 * Matched on symbol rather than address because that is what a brief's fit carries on the page, and
 * the API already resolved the address to a registry symbol. A token the registry does not name has a
 * null symbol and is deliberately not matched: it would be guessing.
 */
export function assetStake(brief: BriefBacking | null, themeId: string, symbol: string): string | null {
    const theme = brief?.themes.find((t) => t.theme === themeId);
    return theme?.assets.find((a) => a.symbol === symbol)?.usdcMinor ?? null;
}

/** A part as a percentage of a whole, for a bar's width. Zero when the whole is zero. */
export function sharePct(part: string, whole: string): number {
    const w = BigInt(whole);
    if (w <= 0n) return 0;
    return Number((BigInt(part) * 10_000n) / w) / 100;
}

/**
 * The verb that is true right now.
 *
 * Simulated fills mean the agent decided to buy and booked the decision; no token moved. Saying it
 * "holds" anything would be the one dishonest sentence on a site whose whole argument is that you can
 * check it.
 */
export function verb(simulated: boolean): string {
    return simulated ? "committed" : "holds";
}

/** Said wherever a number from a simulated fill appears, in the one voice the app uses for caveats. */
export function SimulatedNote({ brief }: { brief: BriefBacking }) {
    if (!brief.simulated) {
        return (
            <Note tone="good">
                {brief.onchainFills} of {brief.fills} fills settled onchain. The transaction for each is listed
                beside it, and the books are reconciled against the wallet's balances.
            </Note>
        );
    }
    return (
        <p className="measure m-0 text-sm text-amber">
            Fills are simulated. The agent ran every pre-trade check, the owner signed the approval, and
            these amounts are what it committed on the books. No token has been bought: swaps stay off
            until the owner enables mainnet with a spend cap.
        </p>
    );
}

/**
 * The band that makes the argument, for a page a visitor reads before paying.
 *
 * The bar is the information: it is where the mandate's theme targets met the evidence the briefs
 * actually found, which is not something a list of numbers shows.
 */
export function BackingBand() {
    const load = useBacking();
    const b = load.k === "ready" ? load.backing : null;
    const brief = b?.briefs[0] ?? null;
    const total = brief?.usdcMinor ?? "0";

    return (
        <section className="border-b border-line">
            <div className="shell band py-[clamp(2.25rem,5vw,3.25rem)]">
                <Spine label="Skin in the game" aside="The agent buys what its own research points at." />
                <motion.div variants={stagger()} initial="hidden" animate="shown" className="min-w-0">
                    <h2 className="text-[clamp(1.6rem,3.2vw,2.3rem)] font-medium leading-[1.06] tracking-[-0.04em]">
                        <MaskedLine delay={0.05}>It spends its own revenue on its own conclusions.</MaskedLine>
                    </h2>

                    {load.k === "down" && (
                        <motion.div variants={riseItem} className="mt-5" aria-live="polite">
                            <Note tone="bad" alert>
                                Could not reach the agent to read what it has bought. It may be restarting.
                            </Note>
                        </motion.div>
                    )}

                    {brief === null && load.k === "ready" && (
                        <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                            The agent has not invested yet. Selling research has to cover what the research cost and
                            fill a protected reserve first, and until it does the surplus is zero and nothing is
                            proposed. That refusal is the design, not a fault, and this band will fill in when it
                            clears.
                        </motion.p>
                    )}

                    {brief !== null && (
                        <>
                            <motion.p variants={riseItem} className="measure mt-5 text-[1.0625rem]">
                                Every sale pays for the brief it sold, tops up a reserve, and only then leaves a
                                surplus. The owner's mandate says what share of that surplus may be invested and in
                                which themes. The agent {verb(brief.simulated)}{" "}
                                <b className="font-medium text-ink">{formatUsdc(total)} USDC</b> of it across{" "}
                                {brief.themes.length === 1 ? "one theme" : `${brief.themes.length} themes`} of the
                                brief it acted on last.
                            </motion.p>

                            <motion.div variants={riseItem} className="mt-8 grid gap-5">
                                {brief.themes.map((theme) => (
                                    <div key={theme.theme} className="grid gap-2">
                                        <div className="flex items-baseline justify-between gap-4">
                                            <span className="font-mono text-sm text-ink">{theme.theme}</span>
                                            <span className="num text-sm text-ink">{formatUsdc(theme.usdcMinor)}</span>
                                        </div>
                                        {/*
                                          * The share each theme got, which the amounts alone do not show.
                                          *
                                          * Drawn, not animated. The width is a measurement, and an animated
                                          * one inside this variant tree settled at a third of its true value
                                          * while looking entirely plausible. A bar that is wrong is worse
                                          * than a bar that does not move.
                                          */}
                                        <div
                                            className="h-1.5 w-full overflow-hidden rounded-full bg-pill"
                                            role="img"
                                            aria-label={`${theme.theme} took ${sharePct(theme.usdcMinor, total).toFixed(1)} percent of what the agent invested`}
                                        >
                                            <div
                                                className="h-full rounded-full bg-lime"
                                                style={{ width: `${sharePct(theme.usdcMinor, total)}%` }}
                                            />
                                        </div>
                                        <p className="m-0 font-mono text-xs text-dim">
                                            {theme.assets
                                                .map((a) => `${a.symbol ?? a.asset.slice(0, 10)} ${formatUsdc(a.usdcMinor)}`)
                                                .join("  ·  ")}
                                        </p>
                                    </div>
                                ))}
                            </motion.div>

                            <motion.div variants={riseItem} className="mt-7 grid gap-3">
                                <SimulatedNote brief={brief} />
                                {b !== null && BigInt(b.unattributed.usdcMinor) > 0n && (
                                    <Note>
                                        A further {formatUsdc(b.unattributed.usdcMinor)} USDC sits in positions from
                                        before the agent recorded which brief justified a trade. It is counted here but
                                        credited to no brief, because it cannot be shown which one argued for it.
                                    </Note>
                                )}
                            </motion.div>
                        </>
                    )}
                </motion.div>
            </div>
        </section>
    );
}

/**
 * The same fact, sized for a brief the reader has already paid for.
 *
 * On the brief it is not an argument any more, it is a column: how much of the agent's own money is
 * behind this theme, and behind each company in it.
 */
export function ThemeStake({ brief, themeId }: { brief: BriefBacking | null; themeId: string }) {
    const stake = themeStake(brief, themeId);
    if (brief === null || stake === null) return null;
    return (
        <Reveal>
            <p className="m-0 mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-dim">
                <span
                    aria-hidden="true"
                    className={`inline-block h-1.5 w-1.5 rounded-full ${brief.simulated ? "bg-amber" : "bg-lime"}`}
                />
                The agent {verb(brief.simulated)}{" "}
                <b className="num font-medium text-ink">{formatUsdc(stake)} USDC</b> of its own revenue to this
                theme{brief.simulated && <span className="text-amber"> (simulated fill)</span>}.
            </p>
        </Reveal>
    );
}
