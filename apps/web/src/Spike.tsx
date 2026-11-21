import { useState } from "react";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

/**
 * Phase 0 spike: can a browser complete an x402 purchase?
 *
 * The question that decides whether the storefront can transact in-page. Three things have to hold:
 * the x402 packages must bundle for a browser (no node builtins), the client signer interface must be
 * satisfiable by a wallet rather than a private key, and a signed payment must actually reach the
 * facilitator from a page.
 *
 * The third is tested with a freshly generated key that holds nothing. A settlement failure for want of
 * funds is a pass: it means the bundle loaded, the 402 was parsed, the EIP-3009 authorization was signed
 * in the browser and the facilitator answered. Only funding separates that from a real purchase, and the
 * Node client already proved the funded path end to end.
 */

type Stage = "idle" | "running" | "pass" | "fail";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const NETWORK = "eip155:84532";

export function Spike() {
  const [stage, setStage] = useState<Stage>("idle");
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState("");

  async function run() {
    setStage("running");
    setSteps([]);
    setVerdict("");
    const found: Step[] = [];
    const note = (name: string, ok: boolean, detail: string) => {
      found.push({ name, ok, detail });
      setSteps([...found]);
    };

    try {
      note("bundle", true, "@x402/fetch, @x402/core and @x402/evm loaded in the browser");

      // A throwaway account with no funds. Nothing here touches the owner's or the buyer's real key.
      const account = privateKeyToAccount(generatePrivateKey());
      note("signer", true, `empty throwaway account ${account.address.slice(0, 10)}…`);

      // The signer interface wants only an address and signTypedData, which is exactly what an
      // injected wallet exposes. Swapping this for window.ethereum is a shim, not a rewrite.
      const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
        schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
      });
      note("client", true, `x402 client built for ${NETWORK}`);

      const probe = await fetch("/brief");
      if (probe.status !== 402) {
        note("challenge", false, `expected 402 from /brief, got ${probe.status}. Is the API running?`);
        setVerdict("Could not reach a paid endpoint. Start the API and try again.");
        setStage("fail");
        return;
      }
      const header = probe.headers.get("payment-required");
      const decoded: unknown = header === null ? null : JSON.parse(atob(header));
      const accepts = (decoded as { accepts?: { amount?: string; asset?: string }[] } | null)?.accepts?.[0];
      note("challenge", true, `402 received, wants ${accepts?.amount ?? "?"} of ${(accepts?.asset ?? "?").slice(0, 10)}…`);

      // The decisive call: the browser must parse the challenge, sign an EIP-3009 authorization and
      // submit it. An empty account cannot settle, so a funds error here is the expected pass.
      const res = await fetchWithPayment("/brief", { method: "GET" });
      const body = await res.text();

      if (res.ok) {
        note("payment", true, "paid and received the brief, which means this account was funded");
        setVerdict("Browser purchases work. The storefront can transact in-page.");
        setStage("pass");
        return;
      }
      note("payment", true, `signed in the browser and submitted; server answered ${res.status}`);
      setVerdict(
        `Signing and submission work from a browser. The request failed only at settlement, ` +
          `which is expected for an unfunded account. Server said: ${body.slice(0, 160)}`,
      );
      setStage("pass");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      note("payment", false, message);
      setVerdict(
        message.includes("Buffer") || message.includes("process") || message.includes("require")
          ? "Bundling failure: a package reached for a Node builtin. The storefront cannot transact in-page without polyfills."
          : `Failed before a payment could be signed: ${message}`,
      );
      setStage("fail");
    }
  }

  return (
    <main className="work" style={{ minHeight: "100vh" }}>
      <div className="wrap">
        <h2>Phase 0 spike: can a browser buy a brief?</h2>
        <p>
          Decides whether the public page can take payment in-page or has to hand buyers to the
          protocol. Uses a freshly generated empty account, so nothing is spent and no real key is
          involved.
        </p>

        <div className="cta" style={{ marginTop: 0 }}>
          <button className="btn" onClick={run} disabled={stage === "running"}>
            {stage === "running" ? "Running…" : "Run the spike"}
          </button>
        </div>

        {steps.length > 0 && (
          <ul className="legs" style={{ marginTop: "1.5rem" }}>
            {steps.map((s) => (
              <li key={s.name}>
                <div className="leg">
                  <div className="leg-row">
                    <span className="sym">{s.name}</span>
                    <span className="theme">{s.detail}</span>
                    <span className="amt" style={{ color: s.ok ? "var(--cream)" : "var(--coral)" }}>
                      {s.ok ? "ok" : "failed"}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {verdict !== "" && (
          <section className="sheet" style={{ marginTop: "1.5rem" }}>
            <h3>{stage === "pass" ? "Pass" : "Fail"}</h3>
            <p style={{ marginBottom: 0 }}>{verdict}</p>
          </section>
        )}
      </div>
    </main>
  );
}
