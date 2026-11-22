import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Button, Chip, Led, Note } from "./Chrome";
import { shortHash } from "./explorer";
import { describeWalletError, hasWallet, type WalletKind } from "./wallet";

/**
 * The connected wallet, as a component sees it.
 *
 * Reactive, which is the whole point of the change: wagmi holds one account and one chain for the
 * app, reconnects them on page load, and re-renders every surface when the person switches account
 * in their wallet. Before this each page kept its own idea of who was connected, a reload forgot it,
 * and switching account in the extension left the page confidently showing the old address.
 */
export interface Wallet {
    address: string | null;
    kind: WalletKind | null;
    busy: boolean;
    error: string | null;
    open: (kind: WalletKind) => Promise<void>;
    close: () => void;
    fail: (e: unknown) => void;
    clear: () => void;
}

const KIND: Record<string, WalletKind> = { coinbaseWallet: "coinbase", injected: "injected" };

export function useWallet(): Wallet {
    const { address, connector } = useAccount();
    const { connectAsync, connectors, isPending } = useConnect();
    const { disconnect } = useDisconnect();
    const [error, setError] = useState<string | null>(null);

    return {
        address: address ?? null,
        kind: connector === undefined ? null : KIND[connector.type] ?? null,
        busy: isPending,
        error,
        open: async (want) => {
            setError(null);
            const target = connectors.find((c) => c.type === (want === "coinbase" ? "coinbaseWallet" : "injected"));
            if (target === undefined) {
                setError("That wallet is not available in this build.");
                return;
            }
            try {
                await connectAsync({ connector: target });
            } catch (e) {
                setError(describeWalletError(e));
            }
        },
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
 * The two ways in, side by side, with the difference stated.
 *
 * Coinbase Wallet first and in lime: it covers the extension, the phone app and a Smart Wallet
 * passkey, so it is the only route for someone with nothing installed. A browser wallet is offered
 * only when one is actually injected, because offering a button that cannot work is worse than
 * offering one fewer.
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
            <div className="flex flex-wrap gap-3">
                <Button onClick={() => void wallet.open("coinbase")} disabled={wallet.busy}>
                    {wallet.busy ? "Opening your wallet…" : "Connect Coinbase Wallet"}
                </Button>
                {hasWallet() && (
                    <Button tone="ghost" onClick={() => void wallet.open("injected")} disabled={wallet.busy}>
                        Connect browser wallet
                    </Button>
                )}
            </div>
            <Note>
                {hasWallet()
                    ? `Either way you need USDC on ${chain}. You do not need ETH: the facilitator pays the gas.`
                    : `Coinbase Wallet works with a passkey, so there is nothing to install. You need USDC on ${chain}, and no ETH: the facilitator pays the gas.`}
            </Note>
            {wallet.error !== null && <Note tone="bad" alert>{wallet.error}</Note>}
        </div>
    );
}
