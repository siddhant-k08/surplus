# @surplus/api

The x402 paid research endpoint. A buyer pays USDC on Base Sepolia and gets the newest verified brief; the sale lands in the ledger as real testnet revenue. Working end to end since 21 Nov 2026.

## Run it

```bash
X402_PAY_TO=0xYourTestWallet npm run api
```

Everything else has a default (see `.env.example`). The server reads `.env` at startup.

## Routes

| Route | Cost | What it does |
| --- | --- | --- |
| `GET /health` | free | network, facilitator, price, payTo, newest brief id, sales booked |
| `GET /brief` | `BRIEF_PRICE_USD` (default `$0.01`) | the newest brief from `BRIEFS_DIR`, with every claim's quote |
| `GET /ledger` | free | the chronological ledger and the sales booked so far |

Unpaid requests to `/brief` get `402 Payment Required` with a `PAYMENT-REQUIRED` header. The body is `{"error":"Payment required"}` only: the brief is never included in the challenge.

## Checking it by hand

```bash
curl -s localhost:4021/health | python3 -m json.tool
```

```bash
curl -sD - -o /dev/null localhost:4021/brief | grep -i '^payment-required' | sed 's/^[^:]*: //' | tr -d '\r' | base64 -d | python3 -m json.tool
```

The decoded challenge should name `eip155:84532`, the Base Sepolia USDC address, your `payTo`, and the price in atomic units (`$0.01` becomes `10000`, USDC having 6 decimals).

## Buying one, end to end

Set two things in `.env`, then run the buyer in a second terminal while the server is up:

```
X402_PAY_TO=0xSellerAddress
X402_BUYER_PRIVATE_KEY=0xThrowawayTestnetKey
```

```bash
npm run buy -w @surplus/api
```

The buyer prints the 402 challenge, pays, prints the settlement, then reads `/ledger` so you can see the sale booked against the transaction hash.

Three things to get right:

- `X402_PAY_TO` must not be the buyer's own address. Paying yourself is not a meaningful test.
- Only the buyer wallet needs test USDC, at least `BRIEF_PRICE_USD` of it. The seller address receives and needs nothing.
- The key is read from `.env` and never printed. Use a throwaway testnet wallet, never a key that holds anything real.

The buyer needs **no testnet ETH**, only USDC. Confirmed onchain on the first real sale: the settlement transaction's sender is the facilitator (`0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf`), not the buyer, so the facilitator submits the signed EIP-3009 authorization and pays the gas. This is a property of the x402.org facilitator, not a guarantee of the protocol.

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
- Buyer side: `wrapFetchWithPaymentFromConfig` and `decodePaymentResponseHeader` from `@x402/fetch`, with the client-side `ExactEvmScheme` from `@x402/evm` (root, not `/exact/server`) and `privateKeyToAccount` from `viem/accounts`.
- API shape read from the installed package: `paymentMiddleware(routes, server)`, `new x402ResourceServer(facilitator).register(network, new ExactEvmScheme()).onAfterSettle(hook)`, `HTTPFacilitatorClient` from `@x402/core/server`. `@x402/paywall` is an optional peer dependency and is not installed: this endpoint serves agents, not a browser paywall.
- `https://x402.org/facilitator/supported` advertises `exact` on `eip155:84532` and no other EVM network, which is why mainnet needs a different facilitator.
- USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's contract address list). The running server's own 402 challenge resolved `$3.00` to `3000000` against that address, which confirms it independently.
