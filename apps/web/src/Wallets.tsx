import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./wagmi";

/**
 * Wallet support, loaded only by the pages that can use one.
 *
 * wagmi, viem and react-query are about 65 kB gzipped, and three of this site's pages are a person
 * reading about an agent: the landing page, the themes and the filings. They have no wallet, no
 * balance and no signature, so they do not pay for one. The app, the library and the owner desk
 * mount this, and inside it wagmi behaves exactly as it would at the root, reconnecting the last
 * wallet on mount.
 *
 * One `QueryClient` for the module, not one per render: a new client on every mount would throw away
 * the cache wagmi keeps behind it.
 */
const queryClient = new QueryClient();

export default function Wallets({ children }: { children: ReactNode }) {
    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </WagmiProvider>
    );
}
