import { useState } from "react";
import { useAccount } from "wagmi";
import { api } from "./api";
import { Button, Chip, Footer, Led, Wordmark } from "./Chrome";
import { ConnectButton } from "./Connect";
import { MaskedLine, motion, riseItem, stagger } from "./motion";
import { signTypedData, describeWalletError, ensureChain, WalletError } from "./wallet";

/**
 * Sign in by signing, not by typing a secret.
 *
 * The statement in the payload says what the signature authorises, because a wallet prompt that only
 * shows hex teaches people to approve without reading. Signing in grants reading and proposing; a trade
 * still needs its own signature.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (address: string) => void }) {
    const { address } = useAccount();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run() {
        if (address === undefined) return;
        setBusy(true);
        setError(null);
        try {
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
        <>
            <div className="shell flex items-center gap-7 py-4">
                <Wordmark />
                <nav aria-label="Main" className="ml-auto flex items-center gap-3">
                    <Chip><Led />Base Sepolia</Chip>
                    <Button href="/" tone="ghost" size="sm">Home</Button>
                </nav>
            </div>

            <main id="main" className="shell grid min-h-[72vh] content-center py-16">
                <motion.div variants={stagger()} initial="hidden" animate="shown" className="max-w-[46rem]">
                    <motion.p
                        variants={riseItem}
                        className="m-0 mb-5 inline-flex items-center gap-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-lime before:h-px before:w-6 before:bg-lime before:content-['']"
                    >
                        Owner only
                    </motion.p>
                    <h1 className="text-[clamp(2.2rem,4.6vw,3.4rem)] font-medium leading-[1.02] tracking-[-0.045em]">
                        <MaskedLine delay={0.12}>The treasury desk.</MaskedLine>
                    </h1>
                    <motion.p variants={riseItem} className="measure mt-6 text-[1.0625rem]">
                        Sign in with the wallet that approves trades. Signing in lets you read the books and ask for a
                        proposal. It does not authorise a trade: each one is signed on its own.
                    </motion.p>
                    {/* The same one button as everywhere else, and then the thing it is for. Connecting
                        and signing in are two steps because they authorise different things, and a desk
                        that did both on one click would be asking for a signature nobody expected. */}
                    <motion.div variants={riseItem} className="mt-8">
                        {address === undefined ? (
                            <ConnectButton />
                        ) : (
                            <Button onClick={run} disabled={busy}>
                                {busy ? "Waiting for your wallet…" : "Sign in with wallet"} <span aria-hidden="true">↗</span>
                            </Button>
                        )}
                    </motion.div>

                    <div className="mt-4 grid gap-2" aria-live="polite">
                        {address !== undefined && (
                            <p className="measure m-0 font-mono text-xs text-dim">
                                Connected as {address}. The desk accepts one address, and will say so if this is not it.
                            </p>
                        )}
                        {error !== null && <p className="measure m-0 text-sm text-flag" role="alert">{error}</p>}
                    </div>
                </motion.div>
            </main>
            <Footer />
        </>
    );
}
