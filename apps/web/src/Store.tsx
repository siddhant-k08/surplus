import { useEffect, useState } from "react";
import { Recover } from "./Recover";
import { formatUsdc } from "./api";
import { connect, hasWallet, describeWalletError } from "./wallet";

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

/**
 * The public face. What is sold, what it costs, and a way to buy it with a wallet.
 *
 * The payment stack is imported only when someone decides to buy, so reading the page costs nothing.
 */
export function Store() {
    const [cat, setCat] = useState<Catalogue | null>(null);
    const [themes, setThemes] = useState("");
    const [busy, setBusy] = useState<null | "brief" | "research">(null);
    const [error, setError] = useState<string | null>(null);
    const [bought, setBought] = useState<Bought | null>(null);

    useEffect(() => {
        fetch("/catalogue")
            .then((r) => r.json())
            .then(setCat)
            .catch(() => setError("Could not reach the agent. It may be restarting."));
    }, []);

    async function purchase(kind: "brief" | "research") {
        setBusy(kind);
        setError(null);
        setBought(null);
        try {
            const address = await connect();
            const { buy } = await import("./buy"); // the payment stack, only now
            const result = await buy({
                path: kind === "brief" ? "/brief" : "/research",
                address,
                network: cat?.network ?? "eip155:84532",
                ...(kind === "research" && { body: { themes: parseThemes(themes) } }),
            });
            setBought({ receipt: result.receipt });
        } catch (e) {
            setError(describeWalletError(e));
        } finally {
            setBusy(null);
        }
    }

    const price = cat?.briefPriceUsd ?? "";
    const custom = cat?.researchPriceUsd ?? "";

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
                        <nav aria-label="Sections">
                            <a href="#buy" aria-current="page">Briefs</a>
                            <a href="#how">How it works</a>
                            <a href="/desk">Owner</a>
                        </nav>
                    </div>

                    <div className="hero" id="buy">
                        <div>
                            <h1>Research you can check, line by line.</h1>
                            <p className="lede">
                                An agent reads SEC filings and writes a brief where every fact carries the
                                sentence it came from. A claim with no verbatim quote never ships. Pay in USDC,
                                keep the brief, check the quotes yourself.
                            </p>

                            <div className="cta">
                                <button className="btn" onClick={() => void purchase("brief")} disabled={busy !== null || !hasWallet()}>
                                    {busy === "brief" ? "Waiting for your wallet…" : `Buy the latest brief, ${price}`}{" "}
                                    <span aria-hidden="true">↗</span>
                                </button>
                                <a className="textlink" href="#how">
                                    How it works <span aria-hidden="true">↗</span>
                                </a>
                            </div>

                            {!hasWallet() && (
                                <p className="lede" style={{ color: "var(--coral)" }}>
                                    You need a browser wallet holding USDC on Base Sepolia to buy here.
                                </p>
                            )}
                            {error !== null && (
                                <p className="lede" style={{ color: "var(--coral)" }}>{error}</p>
                            )}
                            {bought !== null && (
                                <p className="lede">
                                    Paid. <a href={bought.receipt.url}>Open your brief</a>. Keep that link: it is the
                                    only way back to it.
                                </p>
                            )}
                        </div>

                        <aside className="panel" aria-label="What is on sale">
                            <div className="grip" aria-hidden="true" />
                            <p className="where">{cat?.network ?? "loading"} · paid in USDC</p>

                            <div className="slab">
                                <div className="top">
                                    <span className="name">Latest brief</span>
                                    <span className="rate">{price}</span>
                                </div>
                                <div className="row">
                                    <span>
                                        <span className="k">Themes</span>
                                        <span className="v num">{cat?.latest?.themes.length ?? 0}</span>
                                    </span>
                                    <span className="chip">{cat?.latest?.facts ?? 0} facts</span>
                                    <span style={{ textAlign: "right" }}>
                                        <span className="k">Filings</span>
                                        <span className="v num">{cat?.latest?.sources ?? 0}</span>
                                    </span>
                                </div>
                            </div>

                            <div className="slab">
                                <div className="top">
                                    <span className="name">Your own themes</span>
                                    <span className="rate">{custom}</span>
                                </div>
                                <div className="row">
                                    <span className="k" style={{ margin: 0 }}>
                                        Up to {cat?.maxThemes ?? 3} themes, researched on request
                                    </span>
                                </div>
                            </div>

                            {cat !== null && cat.salesBooked > 0 && (
                                <span className="flag">
                                    {cat.salesBooked} sold, {formatUsdc(cat.revenueUsdcMinor)} USDC earned
                                </span>
                            )}
                        </aside>
                    </div>
                </div>
            </header>

            <main className="work" id="how">
                <div className="wrap">
                    <h2>How a brief is built</h2>
                    <p>
                        The agent is not asked to be right. It is asked to show its working, and anything it
                        cannot show is dropped before you see it.
                    </p>

                    <ul className="legs">
                        <li>
                            <div className="leg">
                                <div className="leg-row">
                                    <span className="sym">Filings</span>
                                    <span className="theme">
                                        10-K and 10-Q documents are pulled straight from SEC EDGAR, never from a
                                        summary or a news article.
                                    </span>
                                </div>
                            </div>
                        </li>
                        <li>
                            <div className="leg">
                                <div className="leg-row">
                                    <span className="sym">Quotes</span>
                                    <span className="theme">
                                        A fact survives only if a 20 to 300 character quote appears verbatim in a
                                        filing it cites, and every number in the fact appears in that quote.
                                    </span>
                                </div>
                            </div>
                        </li>
                        <li>
                            <div className="leg">
                                <div className="leg-row">
                                    <span className="sym">Fits</span>
                                    <span className="theme">
                                        A company reaches a theme only through a surviving fact from its own
                                        filing. Evidence is counted in code; the model never scores itself.
                                    </span>
                                </div>
                            </div>
                        </li>
                        <li>
                            <div className="leg">
                                <div className="leg-row">
                                    <span className="sym">Gaps</span>
                                    <span className="theme">
                                        When nothing clears the bar, the theme is returned as a gap. An empty
                                        answer is more useful than a confident one with nothing behind it.
                                    </span>
                                </div>
                            </div>
                        </li>
                    </ul>

                    <h2 style={{ marginTop: "3rem" }}>Commission your own themes</h2>
                    <p>
                        Send up to {cat?.maxThemes ?? 3} themes and the agent researches them against the same
                        filings, under the same rules. {custom} in USDC.
                    </p>
                    <label className="field">
                        <span>One theme per line, as a name and a short description separated by a colon</span>
                        <textarea
                            rows={3}
                            value={themes}
                            placeholder={"AI compute: data centre and accelerator demand\nLongevity biotech: therapies aimed at ageing"}
                            onChange={(e) => setThemes(e.target.value)}
                        />
                    </label>
                    <div className="cta">
                        <button
                            className="btn"
                            onClick={() => void purchase("research")}
                            disabled={busy !== null || !hasWallet() || parseThemes(themes).length === 0}
                        >
                            {busy === "research" ? "Researching, this takes a minute…" : `Commission it, ${custom}`}{" "}
                            <span aria-hidden="true">↗</span>
                        </button>
                    </div>
                    <Recover />
                </div>
            </main>

            <footer>
                <div className="wrap">
                    Research is informational and is not investment advice. Filing text is quoted from SEC EDGAR.
                </div>
            </footer>
        </>
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
