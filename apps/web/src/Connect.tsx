import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, type Connector } from "wagmi";
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
 * Every wallet this visitor can actually use, in the order they should see them.
 *
 * Coinbase Wallet first: it covers the extension, the phone app and a Smart Wallet passkey, so it is
 * the only route for someone with nothing installed. After it, whatever the browser announced over
 * EIP-6963, which is how a modern extension introduces itself and why these arrive with their real
 * name and icon rather than as a generic "injected". The generic connector is the fallback for an
 * extension too old to announce itself, and it is dropped the moment a real one has.
 */
function useWalletOptions(): Connector[] {
    const connectors = useConnectors();
    return useMemo(() => {
        const coinbase = connectors.filter((c) => c.type === "coinbaseWallet");
        const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
        const generic = connectors.filter(
            (c) =>
                c.id === "injected" &&
                announced.length === 0 &&
                typeof window !== "undefined" &&
                (window as { ethereum?: unknown }).ethereum !== undefined,
        );
        return [...coinbase, ...announced, ...generic];
    }, [connectors]);
}

/**
 * One button.
 *
 * It used to be two, Coinbase and browser wallet side by side, which asked a visitor to know the
 * difference before they had any reason to care. Now it is the control every app has: one Connect
 * wallet, and a choice only when there is really more than one thing to choose. Someone with nothing
 * installed has exactly one option and never sees a list.
 */
export function ConnectButton({ label = "Connect wallet" }: { label?: string }) {
    const options = useWalletOptions();
    const { connectAsync, isPending } = useConnect();
    const [error, setError] = useState<string | null>(null);
    const [picking, setPicking] = useState(false);

    async function use(connector: Connector) {
        setPicking(false);
        setError(null);
        try {
            await connectAsync({ connector });
        } catch (e) {
            setError(describeWalletError(e));
        }
    }

    const only = options.length === 1 ? options[0] : undefined;

    return (
        <div className="grid gap-3">
            <div>
                <Button
                    onClick={() => (only === undefined ? setPicking(true) : void use(only))}
                    disabled={isPending || options.length === 0}
                >
                    {isPending ? "Opening your wallet…" : label}
                    <span aria-hidden="true">↗</span>
                </Button>
            </div>
            {picking && <Picker options={options} onPick={(c) => void use(c)} onClose={() => setPicking(false)} />}
            {error !== null && <Note tone="bad" alert>{error}</Note>}
        </div>
    );
}

/**
 * The choice, when there is one.
 *
 * A native `<dialog>`, so the focus trap, the Escape key and the backdrop are the browser's rather
 * than three more things to get wrong. Each row is the wallet's own name and icon, as it announced
 * them, because a list that renamed people's wallets would be a list they could not read.
 */
function Picker({
    options, onPick, onClose,
}: {
    options: Connector[]; onPick: (c: Connector) => void; onClose: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (el === null || el.open) return;
        el.showModal();
    }, []);

    return (
        <dialog
            ref={ref}
            onClose={onClose}
            onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
            aria-label="Choose a wallet"
            className="w-[min(22rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-dim backdrop:bg-black/70"
        >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.09em] text-dim">
                Choose a wallet
                <button
                    type="button"
                    onClick={() => ref.current?.close()}
                    className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-base leading-none text-dim hover:text-ink"
                    aria-label="Close"
                >
                    ×
                </button>
            </div>
            <ul className="m-0 list-none p-0">
                {options.map((c) => (
                    <li key={c.uid} className="border-b border-line last:border-b-0">
                        <button
                            type="button"
                            onClick={() => onPick(c)}
                            className="flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-3.5 text-left text-[0.9375rem] text-ink hover:bg-pill"
                        >
                            {c.icon === undefined ? (
                                <span aria-hidden="true" className="size-5 rounded-[4px] bg-lime" />
                            ) : (
                                <img src={c.icon} alt="" width={20} height={20} className="size-5 rounded-[4px]" />
                            )}
                            {c.name}
                        </button>
                    </li>
                ))}
            </ul>
        </dialog>
    );
}

/** The connect control in context: who is connected, or the one button, with what it needs stated. */
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
            <ConnectButton />
            <Note>
                You need USDC on {chain}. You do not need ETH: the facilitator pays the gas. Nothing installed?
                Coinbase Wallet signs with a passkey, so there is nothing to download.
            </Note>
            {wallet.error !== null && <Note tone="bad" alert>{wallet.error}</Note>}
        </div>
    );
}
