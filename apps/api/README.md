# @surplus/api

The x402 paid research endpoint. A buyer pays USDC on Base Sepolia and gets the newest verified brief; the sale lands in the ledger as real testnet revenue.

## Run it

```bash
X402_PAY_TO=0xYourTestWallet npm run api
```

Everything else has a default (see `.env.example`). The server reads `.env` at startup.

## Routes

| Route | Cost | What it does |
| --- | --- | --- |
| `GET /health` | free | network, facilitator, price, payTo, newest brief id, sales booked |
| `GET /brief` | `BRIEF_PRICE_USD` | the newest brief from `BRIEFS_DIR`, with every claim's quote |
| `GET /ledger` | free | the chronological ledger and the sales booked so far |

Unpaid requests to `/brief` get `402 Payment Required` with a `PAYMENT-REQUIRED` header. The body is `{"error":"Payment required"}` only: the brief is never included in the challenge.

## Checking it by hand

```bash
curl -s localhost:4021/health | python3 -m json.tool
```

```bash
curl -sD - -o /dev/null localhost:4021/brief | grep -i '^payment-required' | sed 's/^[^:]*: //' | tr -d '\r' | base64 -d | python3 -m json.tool
```

The decoded challenge should name `eip155:84532`, the Base Sepolia USDC address, your `payTo`, and the price in atomic units (`$3.00` becomes `3000000`, USDC having 6 decimals).

## How money is booked

Revenue is booked in the SDK's `onAfterSettle` hook, not in the route handler, so nothing is recorded until the facilitator confirms the payment settled. `bookSettlement` in `src/server.ts` holds the rules and is unit tested:

- the ledger key is the settlement transaction, so a replay is idempotent rather than double counted
- the settled amount is counted as USDC minor units only when the asset is the expected USDC, so atomic units of another token are never booked as dollars
- an unsuccessful or zero settlement books nothing
- ledger entries are tagged `testnet` (or `mainnet`), never `sim`: money really moves

State is in memory for now. Persistence is a later milestone, so restarting loses the booked sales.

## Safety

`loadConfig` refuses to start on Base mainnet unless `MAINNET_ENABLED=true`, refuses an unknown network rather than defaulting, and validates `payTo`, the price format and the port. Use a throwaway wallet.

## Verified against primary sources, 21 Nov 2026

- `@x402/core`, `@x402/evm`, `@x402/express` at 2.32.0, published 20 Nov 2026. The older `x402-express` has been at 1.2.0 since April 2026 and is not used.
- API shape read from the installed package: `paymentMiddleware(routes, server)`, `new x402ResourceServer(facilitator).register(network, new ExactEvmScheme()).onAfterSettle(hook)`, `HTTPFacilitatorClient` from `@x402/core/server`. `@x402/paywall` is an optional peer dependency and is not installed: this endpoint serves agents, not a browser paywall.
- `https://x402.org/facilitator/supported` advertises `exact` on `eip155:84532` and no other EVM network, which is why mainnet needs a different facilitator.
- USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's contract address list). The running server's own 402 challenge resolves `$3.00` to `3000000` against that address, which confirms it independently.
