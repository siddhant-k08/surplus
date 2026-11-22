import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import "@coinbase/onchainkit/styles.css";
import { config } from "./wagmi";

/**
 * Wallet support, loaded only by the pages that can use one.
 *
 * wagmi holds the account; OnchainKit is Base's own kit and supplies the one thing worth not writing
 * by hand, the connect modal. `display: "modal"` is what turns a single Connect wallet button into
 * the flow people already know: the button opens a sheet, the sheet lists Coinbase Wallet, MetaMask
 * and anything else detected, and the choice is made once. Two buttons side by side asked a visitor
 * to make that choice before they had any reason to care.
 *
 * The provider is pinned to Base Sepolia because that is the network the agent settles on today.
 * `ensureChain` still moves the wallet before anything is signed, so a wallet pointed elsewhere is
 * corrected rather than left to fail at settlement.
 *
 * Loaded lazily: wagmi, viem, react-query and OnchainKit are not small, and three of this site's
 * pages are a person reading about an agent, with no wallet, no balance and no signature.
 *
 * One `QueryClient` for the module, not one per render: a new client on every mount would throw away
 * the cache wagmi keeps behind it.
 */
const queryClient = new QueryClient();

export default function Wallets({ children }: { children: ReactNode }) {
    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
                <OnchainKitProvider
                    chain={baseSepolia}
                    config={{
                        appearance: { name: "Surplus", mode: "dark", theme: "default" },
                        wallet: { display: "modal", preference: "all" },
                    }}
                >
                    {children}
                </OnchainKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
