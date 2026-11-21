import { useEffect, useState } from "react";
import { formatUsdc } from "./api";

interface Paid {
  receipt: { transaction: string; amountUsdcMinor: string; at: string };
  brief: {
    id: string;
    createdAt: string;
    disclaimer: string;
    sources: { id: string; title: string; publishedAt: string | null }[];
    themes: {
      themeId: string;
      gap: boolean;
      gapReason?: string;
      claims: { id: string; text: string; quotes?: { sourceId: string; text: string }[] }[];
      fits: { symbol: string; fit: number; evidence: number; claimIds: string[] }[];
    }[];
  };
  provider: string;
  model: string;
}

/** What a buyer comes back to. The link is the key; the transaction beside it is proof. */
export function Receipt({ id }: { id: string }) {
  const [paid, setPaid] = useState<Paid | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/receipt/${id}`)
      .then(async (r) => {
        if (r.ok) return setPaid(await r.json());
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "That link does not open anything.");
      })
      .catch(() => setError("Could not reach the agent. It may be restarting."));
  }, [id]);

  if (error !== null) {
    return (
      <header className="stage" style={{ minHeight: "100vh", display: "grid", alignItems: "center" }}>
        <div className="wrap">
          <h1>That link does not open a brief.</h1>
          <p className="lede">{error} If you paid and lost the link, the transaction on Base is still your proof.</p>
          <div className="cta"><a className="btn" href="/">Back to the briefs <span aria-hidden="true">↗</span></a></div>
        </div>
      </header>
    );
  }

  if (paid === null) {
    return (
      <header className="stage" style={{ minHeight: "100vh", display: "grid", alignItems: "center" }}>
        <div className="wrap"><p className="lede">Opening your brief…</p></div>
      </header>
    );
  }

  const sources = new Map(paid.brief.sources.map((s) => [s.id, s]));

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
            <nav aria-label="Sections"><a href="/">Briefs</a></nav>
          </div>
          <div className="hero">
            <div>
              <h1>Your brief.</h1>
              <p className="lede">
                Bought for {formatUsdc(paid.receipt.amountUsdcMinor)} USDC on{" "}
                {new Date(paid.receipt.at).toLocaleDateString()}. Keep this link: it is the only way back.
              </p>
              <p className="lede" style={{ fontSize: ".8125rem" }}>
                Settlement {paid.receipt.transaction.slice(0, 18)}… · {paid.provider} {paid.model}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="work">
        <div className="wrap">
          {paid.brief.themes.map((theme) => {
            const claims = new Map(theme.claims.map((c) => [c.id, c]));
            return (
              <section key={theme.themeId} style={{ marginBottom: "3rem" }}>
                <h2>{theme.themeId}</h2>
                {theme.gap ? (
                  <p>{theme.gapReason ?? "No company cleared the evidence bar for this theme."}</p>
                ) : (
                  <ul className="legs">
                    {theme.fits.map((fit) => {
                      const claim = fit.claimIds[0] === undefined ? undefined : claims.get(fit.claimIds[0]);
                      const quote = claim?.quotes?.[0];
                      const source = quote === undefined ? undefined : sources.get(quote.sourceId);
                      return (
                        <li key={fit.symbol}>
                          <details className="leg" open>
                            <summary>
                              <span className="sym">{fit.symbol}</span>
                              <span className="theme">{claim?.text ?? ""}</span>
                              <span className="amt num">fit {fit.fit}/5</span>
                            </summary>
                            <div className="evidence">
                              {quote !== undefined && <blockquote>“{quote.text}”</blockquote>}
                              <p className="cite">
                                <span>{source?.title ?? "source not listed"}{source?.publishedAt === null || source === undefined ? "" : `, filed ${source.publishedAt}`}</span>
                                {quote !== undefined && <span className="ok">quote found verbatim</span>}
                              </p>
                              <p className="scores">evidence <b>{fit.evidence}</b>/5</p>
                            </div>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </main>

      <footer><div className="wrap">{paid.brief.disclaimer}</div></footer>
    </>
  );
}
