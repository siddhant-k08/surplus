import { useEffect, useState, useSyncExternalStore } from "react";
import { api, get } from "./api";
import { SignIn } from "./SignIn";
import { Desk, type DeskTab } from "./Desk";
import { Store } from "./Store";
import { Receipt } from "./Receipt";
import { Library } from "./Library";
import { Motion } from "./motion";

type Session = { state: "loading" } | { state: "out" } | { state: "in"; address: string };

/**
 * Four surfaces, one bundle: the storefront, a receipt, and the desk's three tabs.
 *
 * A router library would be four hundred lines of dependency for five routes that do not nest. This
 * is the whole of it: read the path, push a new one, tell React when it changed. Links still work as
 * links, so middle-click and open-in-new-tab behave; only in-app navigation is intercepted.
 */
const listeners = new Set<() => void>();
const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};
const current = (): string => window.location.pathname;

export function navigate(to: string): void {
    if (to === current()) return;
    history.pushState(null, "", to);
    for (const fn of listeners) fn();
    window.scrollTo({ top: 0 });
}

if (typeof window !== "undefined") {
    addEventListener("popstate", () => { for (const fn of listeners) fn(); });
}

const TITLES: Record<string, string> = {
    store: "Surplus: cited stock research, paid in USDC",
    receipt: "Your brief: Surplus",
    library: "My briefs: Surplus",
    decision: "Treasury: Surplus",
    mandate: "Mandate: Surplus",
    book: "The book: Surplus",
};

export function App() {
    const path = useSyncExternalStore(subscribe, current, current);
    const receipt = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(path);
    const tab: DeskTab | null =
        path === "/desk" ? "decision" : path === "/desk/mandate" ? "mandate" : path === "/desk/book" ? "book" : null;
    const library = path === "/library";
    const surface = receipt !== null ? "receipt" : library ? "library" : tab ?? "store";

    useEffect(() => {
        document.title = TITLES[surface] ?? TITLES.store!;
    }, [surface]);

    return (
        <Motion>
            {/* The first thing a keyboard reaches, so the nav is not a toll gate on every page. */}
            <a className="skip" href="#main">Skip to the main content</a>
            {receipt !== null ? (
                <Receipt id={receipt[1]!} />
            ) : library ? (
                <LibraryPage />
            ) : tab !== null ? (
                <Owner tab={tab} />
            ) : (
                <Store />
            )}
        </Motion>
    );
}

/** The library needs the same public terms the storefront reads: network, asset and the price. */
function LibraryPage() {
    const [terms, setTerms] = useState<{ network: string; asset: string; briefPriceUsd: string } | null>(null);
    useEffect(() => {
        get<{ network: string; asset: string; briefPriceUsd: string }>("/catalogue").then(setTerms).catch(() => setTerms(null));
    }, []);
    return <Library terms={terms} />;
}

function Owner({ tab }: { tab: DeskTab }) {
    const [session, setSession] = useState<Session>({ state: "loading" });

    useEffect(() => {
        api
            .me()
            .then((me) =>
                setSession(me.signedIn && me.address !== null ? { state: "in", address: me.address } : { state: "out" }),
            )
            .catch(() => setSession({ state: "out" }));
    }, []);

    if (session.state === "loading") {
        return (
            <main id="main" className="shell grid min-h-[70vh] content-center">
                <p className="font-mono text-sm text-dim" role="status">Checking whether you are signed in…</p>
            </main>
        );
    }
    if (session.state === "out") return <SignIn onSignedIn={(address) => setSession({ state: "in", address })} />;
    return <Desk tab={tab} address={session.address} onSignedOut={() => setSession({ state: "out" })} />;
}
