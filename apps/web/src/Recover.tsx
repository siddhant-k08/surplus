import { useState } from "react";
import { formatUsdc, recoverReceipts, recoveryOffer, type RecoveredReceipt } from "./api";
import { connect, describeWalletError, hasWallet, signTypedData } from "./wallet";

/**
 * Getting back to a brief that was paid for.
 *
 * The receipt link is handed over once, in the response to the payment. A closed tab, a dropped
 * connection or a crash between the payment settling and the response arriving leaves someone who has
 * paid with nothing to show for it. The wallet that paid is the thing they still have, so they sign with
 * it and the agent hands back every link that wallet bought.
 */
export function Recover() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [found, setFound] = useState<RecoveredReceipt[] | null>(null);

    const run = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        setFound(null);
        try {
            const address = await connect();
            const offer = await recoveryOffer(address);
            const signature = await signTypedData(address, offer);
            const result = await recoverReceipts({ address, nonce: offer.message.nonce, signature });
            setFound(result.receipts);
        } catch (e) {
            setError(describeWalletError(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="recover">
            <h2 style={{ marginTop: "3rem" }}>Lost your link?</h2>
            <p>
                Your receipt link is shown once, when you pay. If you lost it, connect the wallet you paid
                with and sign a message: it proves the wallet is yours and nothing else. No account, no email.
            </p>
            <div className="cta">
                <button className="textlink" onClick={() => void run()} disabled={busy || !hasWallet()}>
                    {busy ? "Check your wallet…" : "Find my briefs"} <span aria-hidden="true">↗</span>
                </button>
            </div>

            {!hasWallet() && (
                <p className="note">
                    This needs the browser wallet you paid with. Open this page in that browser.
                </p>
            )}
            {error !== null && <p className="note error" role="alert">{error}</p>}

            {found !== null && found.length === 0 && (
                <p className="note" role="status">
                    That wallet has not bought anything here. If you paid from a different wallet, connect
                    that one instead.
                </p>
            )}

            {found !== null && found.length > 0 && (
                <ul className="legs" role="status">
                    {found.map((r) => (
                        <li key={r.id}>
                            <div className="leg">
                                <div className="leg-row">
                                    <a className="sym" href={r.url}>Open brief</a>
                                    <span className="theme">
                                        {r.briefId} · {formatUsdc(r.amountUsdcMinor)} USDC ·{" "}
                                        {new Date(r.at).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
