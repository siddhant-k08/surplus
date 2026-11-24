import type { LedgerTx, Mode } from "./ledger";

/**
 * What the agent has put behind its own research, read back out of the ledger.
 *
 * The two halves of Surplus share a wallet but argue separately: one half writes a brief saying these
 * companies fit this theme, the other half spends the money the brief earned. This joins them. For a
 * given brief it answers how much of the agent's own revenue ended up in the companies that brief
 * pointed at, theme by theme, and whether that money actually moved on a chain or was simulated.
 *
 * It reads `PURCHASE_SETTLED` and `SALE_SETTLED` entries and nothing else, using the structured
 * `briefId` and `theme` each was booked with rather than its memo. A position whose fill predates those fields, or that was
 * built by a demo with no brief behind it, is reported as unattributed rather than assigned to a brief
 * it cannot be proven to belong to.
 *
 * It measures money committed, not money now worth: the ledger books a position at what was paid for
 * it. A sale takes its cost basis back out, so a position the agent has exited stops counting as money
 * behind the brief, and a brief whose every position has been closed falls to zero rather than standing
 * for ever on a commitment that has since been unwound.
 */

export interface BackedAsset {
    /** Lowercase token address. Symbols live in the registry, not in the books. */
    asset: string;
    /** USDC minor units the agent committed to this token under this theme. */
    usdcIn: bigint;
    fills: number;
    /** Exits out of this holding. A position fully sold has `usdcIn` back at zero. */
    sales: number;
    /** Fills that reached a chain. Zero means every one of them was simulated. */
    onchainFills: number;
    /** Transaction hashes, for the fills that had one. The reader's own proof. */
    transactions: string[];
}

export interface BackedTheme {
    theme: string;
    usdcIn: bigint;
    assets: BackedAsset[];
}

export interface BriefBacking {
    briefId: string;
    /** Total committed across every theme of this brief. */
    usdcIn: bigint;
    mode: Mode;
    /** True while no fill behind this brief has ever been sent to a chain. */
    simulated: boolean;
    fills: number;
    sales: number;
    onchainFills: number;
    firstAt: string;
    lastAt: string;
    themes: BackedTheme[];
}

export interface Backing {
    briefs: BriefBacking[];
    /** Money in positions that no brief can be shown to have justified. Never folded into a brief. */
    unattributed: { usdcIn: bigint; fills: number };
    /** Committed across everything, attributed or not, so a reader can check the parts add up. */
    totalUsdcIn: bigint;
}

/** The `positions.` line of a fill: money into the token on a buy, cost basis back out on a sale. */
function positionLine(tx: LedgerTx): { asset: string; usdcIn: bigint } {
    const line = tx.lines.find((l) => l.account.startsWith("positions."));
    if (line === undefined) {
        throw new Error(`entry ${tx.id} is a ${tx.type} with no positions line; the book is malformed`);
    }
    return { asset: line.account.slice("positions.".length).toLowerCase(), usdcIn: line.amount };
}

export function backing(txs: readonly LedgerTx[]): Backing {
    const briefs = new Map<string, BriefBacking>();
    const unattributed = { usdcIn: 0n, fills: 0 };
    let totalUsdcIn = 0n;

    for (const tx of txs) {
        if (tx.type !== "PURCHASE_SETTLED" && tx.type !== "SALE_SETTLED") continue;
        // Negative on a sale, which is what nets the exit out of the brief it was bought for.
        const { asset, usdcIn } = positionLine(tx);
        totalUsdcIn += usdcIn;

        // No brief, or a fill booked before the theme was recorded: countable, not attributable.
        if (tx.briefId === undefined || tx.theme === undefined) {
            unattributed.usdcIn += usdcIn;
            unattributed.fills += 1;
            continue;
        }

        let brief = briefs.get(tx.briefId);
        if (brief === undefined) {
            brief = {
                briefId: tx.briefId,
                usdcIn: 0n,
                mode: tx.mode,
                simulated: true,
                fills: 0,
                sales: 0,
                onchainFills: 0,
                firstAt: tx.at,
                lastAt: tx.at,
                themes: [],
            };
            briefs.set(tx.briefId, brief);
        }

        let theme = brief.themes.find((t) => t.theme === tx.theme);
        if (theme === undefined) {
            theme = { theme: tx.theme, usdcIn: 0n, assets: [] };
            brief.themes.push(theme);
        }
        let holding = theme.assets.find((a) => a.asset === asset);
        if (holding === undefined) {
            holding = { asset, usdcIn: 0n, fills: 0, sales: 0, onchainFills: 0, transactions: [] };
            theme.assets.push(holding);
        }

        holding.usdcIn += usdcIn;
        theme.usdcIn += usdcIn;
        brief.usdcIn += usdcIn;
        if (tx.type === "SALE_SETTLED") {
            holding.sales += 1;
            brief.sales += 1;
        } else {
            holding.fills += 1;
            brief.fills += 1;
        }
        if (tx.at < brief.firstAt) brief.firstAt = tx.at;
        if (tx.at > brief.lastAt) brief.lastAt = tx.at;
        if (tx.txHash !== undefined) {
            holding.onchainFills += 1;
            holding.transactions.push(tx.txHash);
            brief.onchainFills += 1;
            brief.simulated = false;
        }
    }

    // Biggest commitment first at every level, because that is the order a reader cares about. Briefs by
    // their most recent fill, so the brief the agent acted on last is the one at the top.
    // A brief whose every position has been unwound is dropped for the same reason a closed holding is:
    // it is no longer money behind that research, and listing it at zero would read as a total loss.
    const out = [...briefs.values()]
        .filter((b) => b.usdcIn > 0n)
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    for (const brief of out) {
        // A holding that has been fully sold is at zero and is dropped: it is no longer money behind the
        // brief, and listing it at 0.000000 would read as a position that went to nothing.
        for (const theme of brief.themes) {
            theme.assets = theme.assets.filter((a) => a.usdcIn > 0n);
        }
        brief.themes = brief.themes.filter((t) => t.usdcIn > 0n);
        brief.themes.sort((a, b) => (a.usdcIn < b.usdcIn ? 1 : a.usdcIn > b.usdcIn ? -1 : 0));
        for (const theme of brief.themes) {
            theme.assets.sort((a, b) => (a.usdcIn < b.usdcIn ? 1 : a.usdcIn > b.usdcIn ? -1 : 0));
        }
    }
    return { briefs: out, unattributed, totalUsdcIn };
}
