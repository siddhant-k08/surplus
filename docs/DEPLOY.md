# Running Surplus on a server

What a working deployment needs, and why each part is there. Written 21 Nov 2026.

Nothing here provisions anything for you. The accounts, the machine and the money are yours to set up;
this is the list and the reasoning so none of it is guesswork at the wrong moment.

## What the machine has to provide

A small VPS is enough. One Node 22 process, a few hundred megabytes of memory, and a disk.

**The disk is not optional.** The ledger, the mandate history and the receipts are append-only JSONL
files whose integrity is the product. A filesystem that resets between deploys loses the agent's books
and the hash chain that proves nobody edited them. That rules out most serverless hosting unless
persistence moves to a database first, which is not a two-week change.

## Before the first start

1. Copy `.env.example` to `.env` and fill it in. Nothing has a default that spends money.
2. `npm ci` then `npm run build:web`. The API serves `apps/web/dist`, so a deploy that skips the build
   serves the previous bundle, or none.
3. `npm test` and `npm run typecheck`. The money rules are the tests; a deploy that cannot pass them is
   not one to make.

## The values that decide behaviour

| Variable | Why it matters |
|---|---|
| `OWNER_ADDRESS` | The only address whose signature approves a trade. Required; no default |
| `OWNER_TOKEN` | Machine and CLI access. At least 16 characters; never reaches a browser |
| `COOKIE_SECURE` | Leave unset in production. `false` only for plain-http local development |
| `X402_PAY_TO` | Where USDC lands. A throwaway wallet while this is a testnet demo |
| `PUBLIC_LEDGER` | `true` publishes the sales book. The transparency is the pitch, but it is your financial history |
| `MAINNET_ENABLED` | Off. Turning it on is a decision about real money, not a deploy step |
| `EXECUTION_PRIVATE_KEY` | Empty unless real swaps are deliberately on. Empty means simulated fills |
| `MAINNET_SPEND_CAP_USDC` | The ceiling the executor refuses to pass. No default, on purpose |
| `RESEARCH_TOTAL_MAX_USD` | Ceiling on model spend for the life of the process |

## Keeping it running

Run it under something that restarts it and captures its output. A systemd unit is enough:

```ini
[Unit]
Description=Surplus
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/surplus
ExecStart=/usr/bin/npm start -w @surplus/api
Restart=always
RestartSec=5
# the process writes only into data/; nothing else needs to be writable
ReadWritePaths=/opt/surplus/data
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

The process closes its listener on `SIGTERM` and finishes requests already in flight before exiting, with
a ten second ceiling. That matters more than it looks: cutting a paid request in half can leave a buyer
charged by the facilitator with nothing written on this side.

## TLS and the domain

Put a reverse proxy in front and let it hold the certificate. The app speaks plain http on `PORT` and
expects to be reached over https, which is why `COOKIE_SECURE` defaults to on: a Secure cookie is never
sent over plain http, so a misconfigured proxy shows up immediately as a sign-in that will not stick,
rather than as a session cookie travelling in the clear.

## Backing up the books

Everything that cannot be recomputed lives in `data/`:

| File | What is lost without it |
|---|---|
| `ledger-testnet.jsonl` | Which sales happened, and their settlement transactions |
| `ledger-invest-sim.jsonl` | What the agent decided to do with the surplus |
| `mandate.jsonl` | The owner's constraints and their hash chain |
| `receipts.jsonl` | Every buyer's way back to what they bought |

They are append-only, so copying them while the process runs is safe: a reader either sees a line or
does not. A truncated final line is detected on load rather than silently accepted.

```bash
# hourly is generous for a file that grows by a line per sale
install -d /var/backups/surplus
tar czf "/var/backups/surplus/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C /opt/surplus data
```

Restoring is copying them back. The server verifies the mandate chain on load and refuses to start if it
does not verify, so a corrupted restore announces itself instead of trading under constraints nobody set.

## Checking it is alive

`GET /health` answers without authentication and says the mode, the network, the price, the brief on
offer and how many sales are booked. It is the right thing for a monitor to poll.

A deeper check needs the owner token:

```bash
curl -s -H "Authorization: Bearer $OWNER_TOKEN" https://your-host/invest/ledger | jq .reconcile
```

`{"ok": true, "issues": []}` means the books balance, replay cleanly and hold no negative balance where
one would be impossible. If that ever turns false, stop and read it before doing anything else.

## Turning on real swaps

Not a deploy step. It needs, in order: eligibility advice that buying these tokens is lawful for you,
a funded throwaway wallet, `MAINNET_ENABLED=true`, a `MAINNET_SPEND_CAP_USDC` you would be relaxed to
lose, and `EXECUTION_PRIVATE_KEY`. The executor refuses to exist if any of those is missing, and the
startup banner says `execution  simulated (...)` with the reason whenever it has refused.

Note the thing that makes this more than a flag: selling runs on Base Sepolia because that is the only
EVM network the free x402 facilitator serves, and the tokenized stocks exist only on Base mainnet. Real
revenue cannot fund a real swap until both halves are on mainnet, which also needs a paid facilitator.
