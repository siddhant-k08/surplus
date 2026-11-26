import { Suspense, lazy, useEffect, useState, useSyncExternalStore } from "react";
import type { DeskTab } from "./Desk";
import { Landing } from "./Landing";
import { Themes } from "./Themes";
import { Filings } from "./Filings";
import { Receipt } from "./Receipt";
import { Button, Footer, SiteHeader, Spine } from "./Chrome";
import { Motion } from "./motion";

/** The owner's desk is a chunk of its own: see Owner.tsx. */
const Owner = lazy(() => import("./Owner"));

/** The buying pages, with wagmi and viem, loaded only when one is opened: see WalletPages.tsx. */
const WalletPages = lazy(() => import("./WalletPages"));

/**
 * The pages, and the twenty lines of routing that find them.
 *
 * Four public pages, the app, a receipt, and the desk's three tabs. A router library would be four
 * hundred lines of dependency for routes that do not nest. This is the whole of it: read the path,
 * push a new one, tell React when it changed. Links still work as links, so middle-click and
 * open-in-new-tab behave; only in-app navigation is intercepted.
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

/** Where a path that used to work now lives. An old shared link is not allowed to become a 404. */
const MOVED: Record<string, string> = {
    // "Portfolio" was wrong for a shelf of research someone bought: a portfolio is a set of
    // positions, and these are documents. Both old spellings still resolve.
    "/library": "/app/library",
    "/app/portfolio": "/app/library",
    "/store": "/app",
};

/** Where a retired path now lives, or null when the path was never one of ours. */
export const movedTo = (path: string): string | null => MOVED[path] ?? null;

type Route =
    | { k: "home" }
    | { k: "themes" }
    | { k: "filings" }
    | { k: "app" }
    | { k: "library" }
    | { k: "receipt"; id: string }
    | { k: "desk"; tab: DeskTab }
    | { k: "missing" };

export function route(path: string): Route {
    const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    const receipt = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(clean);
    if (receipt !== null) return { k: "receipt", id: receipt[1]! };
    switch (clean) {
        case "":
        case "/": return { k: "home" };
        case "/themes": return { k: "themes" };
        case "/filings": return { k: "filings" };
        case "/app": return { k: "app" };
        case "/app/library": return { k: "library" };
        case "/desk": return { k: "desk", tab: "decision" };
        case "/desk/mandate": return { k: "desk", tab: "mandate" };
        case "/desk/book": return { k: "desk", tab: "book" };
        default: return { k: "missing" };
    }
}

const TITLES: Record<Route["k"], string> = {
    home: "Surplus: cited stock research, paid in USDC",
    themes: "Themes: Surplus",
    filings: "Filings read: Surplus",
    app: "Buy a brief: Surplus",
    library: "Your library: Surplus",
    receipt: "Your brief: Surplus",
    desk: "Owner desk: Surplus",
    missing: "Not found: Surplus",
};

export function App() {
    const path = useSyncExternalStore(subscribe, current, current);

    // A moved path is replaced rather than pushed, so Back goes where the visitor came from and not
    // to the old URL that would only move them again.
    const moved = movedTo(path) ?? undefined;
    useEffect(() => {
        if (moved === undefined) return;
        history.replaceState(null, "", moved);
        for (const fn of listeners) fn();
    }, [moved]);

    const here = route(moved ?? path);

    useEffect(() => {
        document.title = TITLES[here.k];
    }, [here.k]);

    return (
        <Motion>
            {/* The first thing a keyboard reaches, so the nav is not a toll gate on every page. */}
            <a className="skip" href="#main">Skip to the main content</a>
            {here.k === "receipt" ? (
                <Receipt id={here.id} />
            ) : here.k === "desk" ? (
                <Waiting.Boundary><Owner tab={here.tab} /></Waiting.Boundary>
            ) : here.k === "library" || here.k === "app" ? (
                <Waiting.Boundary><WalletPages page={here.k} /></Waiting.Boundary>
            ) : here.k === "themes" ? (
                <Themes />
            ) : here.k === "filings" ? (
                <Filings />
            ) : here.k === "missing" ? (
                <Missing path={path} />
            ) : (
                <Landing />
            )}
        </Motion>
    );
}

/** A dead end that says where the live ones are, rather than an apology. */
function Missing({ path }: { path: string }) {
    return (
        <>
            <SiteHeader here="home" />
            <main id="main">
                <section className="py-[clamp(3rem,7vw,5rem)]">
                    <div className="shell band">
                        <Spine label="Not found" />
                        <div className="min-w-0">
                            <h1 className="text-[clamp(2rem,4.2vw,3rem)] font-medium leading-[1.04] tracking-[-0.045em]">
                                There is no page at <span className="font-mono text-dim">{path}</span>
                            </h1>
                            <p className="measure mt-5">
                                If you are looking for a brief you bought, it is in your library: the wallet that paid
                                is the way back in.
                            </p>
                            <div className="mt-7 flex flex-wrap gap-3">
                                <Button href="/app">Open app <span aria-hidden="true">↗</span></Button>
                                <Button href="/app/library" tone="ghost">Your library</Button>
                                <Button href="/" tone="ghost">Home</Button>
                            </div>
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
        </>
    );
}

/** What stands in while a lazily loaded page arrives, and the boundary that shows it. */
function Waiting() {
    return (
        <main id="main" className="shell grid min-h-[70vh] content-center">
            <p className="font-mono text-sm text-dim" role="status">Opening…</p>
        </main>
    );
}
Waiting.Boundary = function Boundary({ children }: { children: React.ReactNode }) {
    return <Suspense fallback={<Waiting />}>{children}</Suspense>;
};
