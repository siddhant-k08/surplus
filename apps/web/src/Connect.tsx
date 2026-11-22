import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { ConnectWallet, Wallet as OnchainWallet } from "@coinbase/onchainkit/wallet";
import { Button, Chip, Led, Note } from "./Chrome";
import { shortHash } from "./explorer";
import { describeWalletError, type WalletKind } from "./wallet";

/**
 * The connected wallet, as a component sees it.
 *
 * Reactive, which is the point: wagmi holds one account and one chain for the app, reconnects them
 * on page load, and re-renders every surface when the person switches account in their wallet.
 * Before this each page kept its own idea of who was connected, a reload forgot it, and switching
 * account in the extension left the page confidently showing the old address.
 */
export interface Wallet {
    address: string | null;
    kind: WalletKind | null;
    busy: boolean;
    error: string | null;
    close: () => void;
    fail: (e: unknown) => void;
    clear: () => void;
}

const KIND: Record<string, WalletKind> = { coinbaseWallet: "coinbase", injected: "injected" };

export function useWallet(): Wallet {
    const { address, connector, isConnecting, isReconnecting } = useAccount();
    const { disconnect } = useDisconnect();
    const [error, setError] = useState<string | null>(null);

    return {
        address: address ?? null,
        kind: connector === undefined ? null : KIND[connector.type] ?? null,
        busy: isConnecting || isReconnecting,
        error,
        close: () => {
            disconnect();
            setError(null);
        },
        fail: (e: unknown) => setError(describeWalletError(e)),
        clear: () => setError(null),
    };
}

const LABEL: Record<WalletKind, string> = { coinbase: "Coinbase Wallet", injected: "Browser wallet" };

/** The connected wallet, for the top bar. Nothing to press: pressing happens where paying happens. */
export function WalletChip({ wallet }: { wallet: Wallet }) {
    if (wallet.address === null) return null;
    return (
        <Chip title={`${wallet.address}${wallet.kind === null ? "" : ` · ${LABEL[wallet.kind]}`}`}>
            <Led />
            {shortHash(wallet.address, 6, 4)}
        </Chip>
    );
}

/**
 * One button.
 *
 * It opens OnchainKit's wallet modal, which lists whatever the visitor can actually use, so the page
 * never asks anyone to know the difference between a Smart Wallet and an extension before they have
 * a reason to care. The button itself is ours, through the `render` prop, because a stock button in
 * someone else's styling is the one element on the page that would look borrowed.
 */
export function ConnectRow({ wallet, chain }: { wallet: Wallet; chain: string }) {
    if (wallet.address !== null) {
        return (
            <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[0.8125rem] text-dim">
                    {wallet.kind === null ? "Connected" : LABEL[wallet.kind]} ·{" "}
                    <span className="text-ink" title={wallet.address}>{shortHash(wallet.address, 6, 4)}</span>
                </span>
                <Button tone="ghost" size="sm" onClick={wallet.close}>Disconnect</Button>
            </div>
        );
    }

    return (
        <div className="grid gap-3">
            <OnchainWallet>
                <ConnectWallet
                    render={({ onClick, status }) => (
                        <Button onClick={onClick} disabled={status === "connecting"}>
                            {status === "connecting" ? "Opening your wallet…" : "Connect wallet"}
                            <span aria-hidden="true">↗</span>
                        </Button>
                    )}
                />
            </OnchainWallet>
            <Note>
                You need USDC on {chain}. You do not need ETH: the facilitator pays the gas. No wallet yet?
                Coinbase Wallet in the list signs with a passkey, so there is nothing to install.
            </Note>
            {wallet.error !== null && <Note tone="bad" alert>{wallet.error}</Note>}
        </div>
    );
}
