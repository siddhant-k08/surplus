import { useState } from "react";
import { api } from "./api";
import { connect, hasWallet, signTypedData, describeWalletError, ensureChain, WalletError } from "./wallet";

/**
 * Sign in by signing, not by typing a secret.
 *
 * The statement in the payload says what the signature authorises, because a wallet prompt that only
 * shows hex teaches people to approve without reading. Signing in grants reading and proposing; a trade
 * still needs its own signature.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (address: string) => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run() {
        setBusy(true);
        setError(null);
        try {
            const address = await connect();
            const offer = await api.nonce();
            // The desk knows which address it will accept and says so in the payload, so a mismatch is
            // worth catching here. Signing first would spend a wallet prompt to earn "not a valid owner
            // signature", which is true and tells nobody which wallet to use instead.
            if (address.toLowerCase() !== offer.message.address.toLowerCase()) {
                throw new WalletError(
                    `This desk only accepts ${offer.message.address}, and your wallet offered ${address}. ` +
                    "Switch to the owner account in your wallet and sign in again.",
                );
            }
            // The domain pins a chain, and a wallet pointed elsewhere refuses to sign typed data for it.
            // Asking first turns a refusal nobody can act on into a switch prompt.
            await ensureChain(offer.domain.chainId);
            const signature = await signTypedData(address, offer);
            const { address: confirmed } = await api.verify(offer.message.nonce, signature);
            onSignedIn(confirmed);
        } catch (e) {
            setError(describeWalletError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <header className="stage" style={{ minHeight: "100vh", display: "grid", alignItems: "center" }}>
            <div className="wrap">
                <div style={{ maxWidth: "34rem" }}>
                    <h1>The owner desk.</h1>
                    <p className="lede">
                        Sign in with the wallet that approves trades. Signing in lets you read the books and
                        ask for a proposal. It does not authorise a trade: each one is signed on its own.
                    </p>

                    <div className="cta">
                        <button className="btn" onClick={run} disabled={busy || !hasWallet()}>
                            {busy ? "Waiting for your wallet…" : "Sign in with wallet"}
                        </button>
                    </div>

                    {/* A missing wallet is a circumstance, not a failure. Coral is for what went wrong. */}
                    {!hasWallet() && (
                        <p className="note">
                            No browser wallet found. Install one to sign in, or drive the owner routes from a
                            script with the owner token.
                        </p>
                    )}
                    {error !== null && (
                        <p className="note error" role="alert">
                            {error}
                        </p>
                    )}
                </div>
            </div>
        </header>
    );
}
