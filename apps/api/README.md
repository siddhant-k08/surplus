# @surplus/api

The x402 paid research endpoint. A buyer pays USDC on Base and gets the newest verified brief; the sale lands in the ledger as real revenue, tagged with the network it settled on. Working on Base Sepolia since 21 Nov 2026 and in production on Base mainnet since 27 Nov 2026. A local run defaults to Sepolia.

## Run it

```bash
X402_PAY_TO=0xYourTestWallet npm run api
```

Everything else has a default (see `.env.example`). The server reads `.env` at startup.

## Routes

| Route | Cost | What it does |
| --- | --- | --- |
| `GET /health` | free | network, facilitator, price, payTo, newest brief id, sales booked |
| `GET /brief` | `BRIEF_PRICE_USD` (default `$0.25`) | the newest brief from `BRIEFS_DIR`, with every claim's quote |
| `POST /research` | `RESEARCH_PRICE_USD` (default `$2.00`) | a brief generated for the themes you send |
| `GET /ledger` | free | the chronological ledger and the sales booked so far |

Unpaid requests to `/brief` get `402 Payment Required` with a `PAYMENT-REQUIRED` header. The body is `{"error":"Payment required"}` only: the brief is never included in the challenge.

## Checking it by hand

```bash
curl -s localhost:4021/health | python3 -m json.tool
```

```bash
curl -sD - -o /dev/null localhost:4021/brief | grep -i '^payment-required' | sed 's/^[^:]*: //' | tr -d '\r' | base64 -d | python3 -m json.tool
```

On the default network the decoded challenge should name `eip155:84532`, the Base Sepolia USDC address, your `payTo`, and the price in atomic units (`$0.25` becomes `250000`, USDC having 6 decimals).

## Buying one, end to end

Set two things in `.env`, then run the buyer in a second terminal while the server is up:

```
X402_PAY_TO=0xSellerAddress
X402_BUYER_PRIVATE_KEY=0xThrowawayKey
```

```bash
npm run buy -w @surplus/api
```

The buyer prints the 402 challenge, pays, prints the settlement, then reads `/ledger` so you can see the sale booked against the transaction hash.

Three things to get right:

- `X402_PAY_TO` must not be the buyer's own address. Paying yourself is not a meaningful test.
- Only the buyer wallet needs test USDC, at least `BRIEF_PRICE_USD` of it. The seller address receives and needs nothing.
- The key is read from `.env` and never printed. Use a throwaway wallet that holds no more than you plan to spend.

The buyer needs **no testnet ETH**, only USDC. Confirmed onchain on the first real sale: the settlement transaction's sender is the facilitator (`0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf`), not the buyer, so the facilitator submits the signed EIP-3009 authorization and pays the gas. This is a property of the x402.org facilitator, not a guarantee of the protocol.

### Buying on mainnet

This spends real USDC. The buyer wallet needs `BRIEF_PRICE_USD` of USDC on Base and no ETH.

```bash
X402_API_URL=https://your-host X402_NETWORK=eip155:8453 MAINNET_ENABLED=true npm run buy -w @surplus/api
```

Run it once. If it fails after "Paying and fetching...", check whether the payment settled before trying again.

## On-demand research

```
POST /research   {"themes":[{"name":"AI compute","description":"data center and accelerator demand","keywords":["data center","GPU"]}]}
```

At most 3 themes, each with a name (80 characters), a description (300) and up to 20 keywords. An `id` is derived from the name when you do not send one.

Why it costs more than `GET /brief`: generating a brief makes real SEC requests and real model calls. `RESEARCH_MAX_USD` caps what one brief may cost, and the server **refuses to start** if that cap exceeds `RESEARCH_PRICE_USD`, so a generated brief can never cost more than the buyer paid.

Two briefs for the same themes inside `BRIEF_MAX_AGE_SECONDS` share one generation: the second request is served from the saved brief and costs nothing to produce. The response says which happened (`"cached": true|false`).

The scheme's payment flow is `authorization`: payment is verified before the handler runs and settled after it returns, and a handler that throws cancels the verified payment. So a failed generation is allowed to propagate rather than be swallowed, and the buyer is not charged for a brief they never received. Invalid themes are refused with `400` before any model call.

### Buyer themes are untrusted input

A buyer's theme text goes into the model prompt alongside the filings, so it is untrusted in the same way a filing is. `normalizeThemes` rejects angle brackets (so a description cannot forge a `</source>` tag and break out of the untrusted block), newlines and control characters (so it cannot fake prompt structure), and oversized or numerous themes (which would push the real passages out of the context window).

Those checks are a hardening layer, not the defence. The defence is verification: a fact survives only with a verbatim quote from a real filing, a fit survives only with a surviving fact from that company's own filing, evidence is computed in code, and the model never touches money. A buyer who talks the model into enthusiasm still cannot manufacture a quote that is not in the document.

## Owner routes

These decide what to do with money, so they sit behind `OWNER_TOKEN` (at least 16 characters; the server refuses to start without it). Send it as `Authorization: Bearer <token>`.

| Route | What it does |
| --- | --- |
| `GET /mandate` | current mandate version, hash and terms |
| `GET /mandate/history` | every version, with the hash chain verified |
| `POST /mandate` | the owner changes their own terms, creating the next version |
| `POST /invest/sync` | books every brief's model cost, mirrors each sale to the brief it bought, settles each earner |
| `POST /invest/propose` | allocates the investable surplus, quotes it live, creates a proposal |
| `POST /invest/approve` | records the owner's **EIP-712 signature** over the offered approval |
| `POST /invest/execute` | re-quotes, runs the pre-trade gates, fills (simulated unless `INVEST_MODE=mainnet`) |
| `GET /invest/proposals` | proposals this process knows about |
| `GET /invest/ledger` | the investing book, its balances and a reconciliation |

Propose, approve and execute are three separate calls on purpose. Nothing here ever approves on the owner's behalf, and `execute` refuses a proposal that was not approved.

The bearer token decides **who may reach** these routes. It does not authorize a trade: approving one requires the owner's EIP-712 signature, so holding the token is not enough.

### Approvals are signed

There is no unsigned approval path. `OWNER_ADDRESS` is required and the server refuses to start without it.

1. `POST /invest/propose` returns the proposal **and** `toSign`: the exact EIP-712 payload, including an expiry this server chose. Recomputing it at approval time would drift by the round trip and no signature would ever match.
2. The owner signs that payload. `npm run approve -w @surplus/api -- <proposalId>` does it from the command line with `OWNER_PRIVATE_KEY`, standing in for a wallet UI. The key is read from `.env` and never printed.
3. `POST /invest/approve {id, signature}` verifies the signature against the stored payload and the configured owner address, then records the approval.

What the signature binds, and why each field is in it:

| Field | Stops |
| --- | --- |
| `proposalHash` | moving the signature to a different set of legs |
| `mandateVersion`, `mandateHash` | approving under constraints that have since changed |
| `maxUsdcIn` | executing more than the owner agreed to spend |
| `expiresAt` | replaying a stale signature later |
| `chainId` (domain) | a testnet signature being valid on mainnet |

The owner address comes from configuration, never from the request: a caller that supplied the address it signed with would be authorizing itself. `maxUsdcIn` and both hashes are always computed by the agent from the proposal and the current mandate, never taken from the caller, and a supplied `expiresAt` is clamped to the mandate's `approvalExpirySeconds` so a signature cannot widen the window the owner set. A proposal can only be approved from `PROPOSED`, so a signature is single use.

Note on where this is enforced: `Treasury.approve` in core still accepts an approval without a signature, because the simulated demos use it. The requirement lives in the API layer (`InvestingEngine.approve` refuses without a verifier and a valid signature). Do not assume core enforces it.

### The mandate is the owner's, and it is versioned

`POST /mandate` takes a partial update: only the fields you send change, everything else carries over, so a request about one limit cannot silently reset the rest. A misspelled field name is **refused** rather than ignored, which is the difference between a typo that does nothing and a typo you never notice. Amounts are decimal strings (`"0.50"`), never floats. The response names exactly what changed and reminds you that outstanding approvals were bound to the previous version and now need reapproval.

Versions are appended to `MANDATE_PATH` as JSONL and hash chained: each hash covers its own terms, its version number and the previous hash. On load the whole chain is recomputed, so an edited limit, a removed version or a reordered history is detected and the server **refuses to start**. Better to stop than to trade under constraints nobody set.

A stored mandate is authoritative. The terms in `src/index.ts` are only used to create version 1 on a first run; after that they are never applied again, so a deployment cannot quietly reset the owner's constraints back to the code's defaults.

The agent never creates a version on its own: `buildServer` only gets the ability to change the mandate because `index.ts` hands it an `updateMandate` function, and without that the route returns 409.

### Two books, on purpose

The sales book (`LEDGER_PATH`) records money received onchain and is tagged `testnet` or `mainnet`, one book per network. The investing book (`INVEST_LEDGER_PATH`) records what the agent decided to do with the surplus and is tagged `sim` while fills are simulated. A simulated fill must never land in the book that records real money, so `/invest/sync` mirrors the revenue total into the investing book with an entry naming the transactions it stands for, and reads the sales book read-only.

Revenue and costs are attributed per brief. Every saved brief's model cost is booked exactly once (keyed `llm-<briefId>`), because a brief costs real money whether or not anyone buys it. Each sale is mirrored individually, keyed and tagged with its settlement transaction, and attributed to the brief that sale actually bought, which the sales ledger records. Then every brief that earned something is settled in turn, so the first fills the reserve gap and later ones go to surplus.

A sale written before per-sale attribution existed carries no brief id; its revenue is kept under the brief id `unattributed` and `/invest/sync` reports how many such sales there were, rather than quietly assigning them to the newest brief.

An investing book that still holds a *lumped* revenue entry from the old scheme is refused on startup with a message naming the file: which sales it covered cannot be recovered, and guessing would either double count or lose revenue. The book is simulated and rebuilds from the sales ledger and the saved briefs, so deleting it is the fix.

`OPENING_FLOAT_USDC` is the owner's working capital, booked once against `equity.opening`. It is needed because a brief's model cost is spent before any revenue arrives: without it, operating cash goes negative and `reconcileInternal` rightly reports money that was never there.

## How money is booked

Revenue is booked in the SDK's `onAfterSettle` hook, not in the route handler, so nothing is recorded until the facilitator confirms the payment settled. `bookSettlement` in `src/server.ts` holds the rules and is unit tested:

- the ledger key is the settlement transaction, so a replay is idempotent rather than double counted
- the settled amount is counted as USDC minor units only when the asset is the expected USDC, so atomic units of another token are never booked as dollars
- an unsuccessful or zero settlement books nothing
- ledger entries are tagged `testnet` (or `mainnet`), never `sim`: money really moves

Booked sales persist in JSONL files, or in Postgres when `DATABASE_URL` is set.

## Safety

`loadConfig` refuses to start on Base mainnet unless `MAINNET_ENABLED=true`, refuses an unknown network rather than defaulting, and validates `payTo`, the price format and the port. Use a throwaway wallet.

## Verified against primary sources, 21 Nov 2026

- `@x402/core`, `@x402/evm`, `@x402/express` at 2.32.0, published 20 Nov 2026. The older `x402-express` has been at 1.2.0 since April 2026 and is not used.
- Buyer side: `wrapFetchWithPaymentFromConfig` and `decodePaymentResponseHeader` from `@x402/fetch`, with the client-side `ExactEvmScheme` from `@x402/evm` (root, not `/exact/server`) and `privateKeyToAccount` from `viem/accounts`.
- API shape read from the installed package: `paymentMiddleware(routes, server)`, `new x402ResourceServer(facilitator).register(network, new ExactEvmScheme()).onAfterSettle(hook)`, `HTTPFacilitatorClient` from `@x402/core/server`. `@x402/paywall` is an optional peer dependency and is not installed: this endpoint serves agents, not a browser paywall.
- `https://x402.org/facilitator/supported` advertises `exact` on `eip155:84532` and no other EVM network, which is why mainnet needs another one. `X402_FACILITATOR=local` settles in this process and is what production uses (`docs/DEPLOY.md`).
- USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's contract address list). The running server's own 402 challenge resolved `$3.00` to `3000000` against that address, which confirms it independently.
