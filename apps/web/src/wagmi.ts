import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";

/**
 * One wallet configuration for the whole app.
 *
 * Connecting used to be hand-rolled: a module-level provider variable, a registry of two SDKs, and
 * every surface asking "is something connected?" in its own way. Nothing told the page when an
 * account changed, a reload forgot the wallet, and the desk and the storefront could disagree about
 * who was signed in. wagmi is one store that every component reads, it reconnects on mount, and it
 * reports account and chain changes as state rather than as events nobody subscribed to.
 *
 * Two connectors, both real paths. Coinbase Wallet covers the extension, the mobile app and a Smart
 * Wallet passkey, which is the only route for someone with nothing installed; `options: "all"` is what
 * offers all three rather than forcing one. `injected` covers MetaMask and anything else already in
 * the browser. Both are EIP-1193 underneath, so paying, signing in and recovering a receipt do not
 * care which was chosen.
 *
 * The Coinbase SDK itself is not in this chunk: its connector imports it only when someone picks it.
 */
export const config = createConfig({
    chains: [baseSepolia, base],
    connectors: [
        coinbaseWallet({
            appName: "Surplus",
            appLogoUrl: typeof window === "undefined" ? null : `${window.location.origin}/favicon.svg`,
            preference: { options: "all" },
        }),
        injected(),
    ],
    transports: {
        [baseSepolia.id]: http(),
        [base.id]: http(),
    },
});

declare module "wagmi" {
    interface Register {
        config: typeof config;
    }
}
