import { useEffect, useState } from "react";
import { api } from "./api";
import { SignIn } from "./SignIn";
import { Desk } from "./Desk";
import { Store } from "./Store";
import { Receipt } from "./Receipt";

type Session = { state: "loading" } | { state: "out" } | { state: "in"; address: string };

/**
 * Three surfaces, one bundle: the public storefront, a receipt, and the owner desk.
 * Path matching rather than a router, because there are three routes and none of them nest.
 */
export function App() {
  const path = window.location.pathname;

  const receipt = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(path);
  if (receipt !== null) return <Receipt id={receipt[1]!} />;

  if (path !== "/desk") return <Store />;
  return <Owner />;
}

function Owner() {
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
      <header className="stage" style={{ minHeight: "100vh", display: "grid", alignItems: "center" }}>
        <div className="wrap"><p className="lede">Checking whether you are signed in…</p></div>
      </header>
    );
  }
  if (session.state === "out") return <SignIn onSignedIn={(address) => setSession({ state: "in", address })} />;
  return <Desk address={session.address} onSignedOut={() => setSession({ state: "out" })} />;
}
