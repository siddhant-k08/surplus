import { useState } from "react";
import { formatUsdc, recoverReceipts, recoveryOffer, type RecoveredReceipt } from "./api";
import { connect, describeWalletError, hasWallet, signTypedData } from "./wallet";
import { Button } from "./Chrome";
import { Reveal } from "./motion";

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
        <section>
            <Reveal>
                <h2 className="text-[clamp(1.7rem,3vw,2.3rem)] font-medium leading-[1.1] tracking-[-0.035em]">
                    Sign with it and the agent hands your briefs back.
                </h2>
                <p className="measure mt-4">
                    Your receipt link is shown once, when you pay. If you lost it, connect the wallet you paid with
                    and sign a message: it proves the wallet is yours and nothing else. No account, no email.
                </p>
            </Reveal>

            <div className="mt-6">
                <Button tone="ghost" onClick={() => void run()} disabled={busy || !hasWallet()}>
                    {busy ? "Check your wallet…" : "Find my briefs"} <span aria-hidden="true">↗</span>
                </Button>
            </div>

            <div className="mt-4 grid gap-2" aria-live="polite">
                {!hasWallet() && (
                    <p className="measure m-0 text-sm text-dim">
                        This needs the browser wallet you paid with. Open this page in that browser.
                    </p>
                )}
                {error !== null && <p className="measure m-0 text-sm text-flag" role="alert">{error}</p>}
                {found !== null && found.length === 0 && (
                    <p className="measure m-0 text-sm text-dim" role="status">
                        That wallet has not bought anything here. If you paid from a different wallet, connect that
                        one instead.
                    </p>
                )}
            </div>

            {found !== null && found.length > 0 && (
                <ul className="mt-6 list-none border-t border-line p-0" role="status">
                    {found.map((r) => (
                        <li key={r.id} className="border-b border-line">
                            <a
                                href={r.url}
                                className="group flex flex-wrap items-baseline gap-x-4 gap-y-1 py-4 no-underline"
                            >
                                <span className="font-mono text-sm text-ink underline decoration-line underline-offset-4 group-hover:decoration-lime">
                                    Open brief
                                </span>
                                <span className="text-sm text-dim">{r.briefId}</span>
                                <span className="ml-auto font-mono text-sm text-ink">
                                    {formatUsdc(r.amountUsdcMinor)} USDC
                                </span>
                                <span className="font-mono text-xs text-dim">
                                    {new Date(r.at).toLocaleDateString()}
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
