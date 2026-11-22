import { useEffect, useState } from "react";
import { api } from "./api";
import { SignIn } from "./SignIn";
import { Desk, type DeskTab } from "./Desk";
import Wallets from "./Wallets";

type Session = { state: "loading" } | { state: "out" } | { state: "in"; address: string };

/**
 * The owner's half of the app, behind its own entry point.
 *
 * Split from the router so it is a chunk of its own. The desk, the mandate editor and the evidence
 * reader are the largest thing in this codebase and exactly one person will ever open them; a
 * visitor reading the landing page should not download the controls for someone else's treasury.
 */
export default function Owner({ tab }: { tab: DeskTab }) {
    return (
        <Wallets>
            <Desk_ tab={tab} />
        </Wallets>
    );
}

function Desk_({ tab }: { tab: DeskTab }) {
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
