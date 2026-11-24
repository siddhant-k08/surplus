# Surplus handoff notes

Written 21 Nov 2026 when the project moved from a Claude chat to Claude Code. The chat also produced a 10-section build plan, saved as a Claude doc titled "Surplus: Build Plan for Base Stocks Maxxing Season"; Siddhant has the link.

## Where we stopped

1. The research pipeline works end to end against real SEC filings and Gemini (`gemini-3.1-flash-lite`). Latest real run: 3 model calls, about 70,600 input tokens, cost about $0.021 booked at paid-tier rates, zero validation issues.
2. `npm test` runs core (244 tests, 26 files) and the API (100 tests, 6 files).
3. Milestone 1 (research quality) is closed, 21 Nov 2026. What the diagnosis found:
   - The dominant cause of dropped facts was never paraphrasing or `htmlToText`. It was the `MAX_QUOTE` 300-character cap. The model quoted real filing text and ran past 300 characters, usually to finish a sentence or a list of examples, and `quoteInText` rejected it on length while the drop message said "no verbatim quote found". A read-only spike confirmed the Alphabet quote was present verbatim in the filing; `htmlToText` is exonerated.
   - Fixed by `quoteCheck` in `src/pipeline.ts`, which returns `ok`, `too_short`, `too_long`, `not_found`, plus an `uncited_source` case in `assembleTheme`. Drop messages now name the reason and the character count. `quoteInText` is a boolean wrapper over it, so callers are unchanged.
   - The prompt now states the cap as a hard rule, asks for under 200 characters, allows a quote to start and stop mid-sentence, and forbids extending a quote to finish a sentence or a list.
   - Result: drops fell from 9 to 5. ai-compute recovered GOOGL, NVDA, MSFT and AMZN (all at evidence 2). platform-giants went from 1 surviving fit to 5 (META, AMZN, MSFT, TSLA, SPCX).
   - longevity-biotech comes out as a gap, and the Alphabet moonshot-factory leak is gone. NVDA is now correctly dropped there by the keyword rule. The keyword patch does what it was meant to do.
4. Residual, and it is a model limit rather than a bug: Flash-Lite still produces the occasional over-long or recited quote. In the last run GOOGL lost a fact to a 343-character quote and AAPL lost one to a quote not present in the cited document. Both are reported accurately now. Per the original plan, keep Flash-Lite for testing and use a Flash model for the recorded demo; expect those two to survive there.

## Integration milestone, closed 21 Nov 2026

`demo-live.ts` now runs the real loop: newest brief from `docs/briefs/`, real metered cost booked, surplus, allocation, real KyberSwap quotes, simulated fills, reconciled ledger.

- `loadLatestBrief()` reads `docs/briefs/*.json`, picks the newest by `brief.createdAt`, and reads `costUsdcMinor` as a decimal string so the cost never passes through a float.
- The brief is re-checked with `validateBrief` against the set trusted right now, not the set trusted when it was written, and the script refuses to trade if it does not validate. A brief can outlive a token's trusted status.
- Cost booked as `accrueCost({ kind: "llm", amount: costUsdcMinor, memo: "metered estimate at paid-tier rates" })`, ids keyed to the brief id so a rerun is idempotent. The $3.00 sale price is still simulated and labelled.
- Each proposed leg prints the verified claim and its quote underneath, which is the rule from "Known limits of the research checks".
- Last run: 12 legs merged into 8 swaps, 0.991524 USDC total, 32 pre-trade gates ok, 0 warnings, 0 blocks, 12 simulated fills, `reconcileInternal` ok. longevity-biotech stays uninvested with reason `gap` and 1 unit lands as `unassigned` rounding.

Bug this found and fixed in core: `Treasury.execute` keyed fills `fill:<proposal>:<asset>`, so a proposal holding two legs for the same asset threw "Idempotency key reused with different content" and the whole loop died. Real research puts one company in several themes (TSLA, META, MSFT and AMZN each appear twice), which the placeholder fits never did. The key is now `fill:<proposal>:<legIndex>:<asset>`; legs are fixed when the proposal is created, so the index is stable across retries. Regression test added in `test/treasury.test.ts`.

## Gas per leg: decided 21 Nov 2026, merge swaps

The problem: 12 legs averaging about $0.083, about $0.0032 quoted gas each, so roughly 4 percent per leg and about $0.038 on $0.99 invested. Four tokens were bought twice because they sit in two themes.

Decision: merge swaps, in `src/swapplan.ts`. Raising `minTradeUsdc` was rejected for two reasons. It is a term of the user's mandate, and the agent never changes user constraints. It also leaves the owner's money uninvested to save the agent gas, which is the wrong trade to make on someone else's behalf.

How it is built, and what it deliberately does not touch:

- `swapPlan(legs, maxTradeUsdc)` groups legs buying the same token into one `SwapOrder`, with `parts` recording how much each theme contributed. On the current brief this is 8 swaps for 12 legs, so four swaps of gas are saved with the allocation unchanged.
- Allocation, policy checks, approvals and the ledger still work on per-theme legs. This matters: `checkProposal` verifies theme targets by grouping legs on `leg.theme`, so collapsing two themes into one leg would break a mandate guarantee. Merging belongs to execution, not to allocation.
- Each order is capped at `maxTradeUsdc` and split when the merged total would exceed it. That term is the owner's limit on a single trade, and merging must not quietly widen it. A split keeps the remainder rather than dropping it.
- A merged order takes the tightest `maxSlippageBps` of its legs, never the loosest.
- `swapPlanTotal` must equal the leg total; `demo-live.ts` asserts this before proposing.

Still to do when real execution is built (milestone 5): the executor should swap once per `SwapOrder` while the ledger keeps posting one `PURCHASE_SETTLED` per leg, so theme attribution survives in the ledger. Today's fills are simulated, so the plan is printed and asserted but not yet the thing that moves money.

## x402 endpoint, working end to end 21 Nov 2026

`apps/api` (`@surplus/api`) sells the brief for real USDC on Base Sepolia. First real sale settled 21 Nov 2026.

Proof of the first sale: price `$0.01` -> amount `10000`, payer `0x8Ab8b5d0b8806868B636B9251e2e1d2753356384`, transaction `0x606c3a6bb4068f8e3faf2aa288750c4ee5c905841eaff5b7fd7535f107c6c702`, block 61449727. The seller ledger then showed one `PAYMENT_RECEIVED` tagged `testnet` for 0.010000 USDC carrying that hash, and one booked sale. Payment, settlement, booking and the brief handoff all work.

Package choice, verified rather than assumed. The CDP seller quickstart describes `@coinbase/cdp-sdk/x402` with `createX402Server` and `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`. Web results described the older `x402-express` with `paymentMiddleware(payTo, routes, facilitator)`. Both are real but they are different generations, so the npm registry settled it: `@x402/core`, `@x402/evm` and `@x402/express` are at 2.32.0 published 20 Nov 2026, while `x402-express` has sat at 1.2.0 since April 2026 and `@coinbase/x402` since Dec 2025. We use the 2.x scoped line with the free facilitator, so no CDP account or API keys are needed.

API shape was read from the installed package's own README and type declarations, not from a blog post:

- `paymentMiddleware(routes, resourceServer)` from `@x402/express`
- `new x402ResourceServer(facilitator).register("eip155:84532", new ExactEvmScheme()).onAfterSettle(hook)`
- `HTTPFacilitatorClient` from `@x402/core/server`, `ExactEvmScheme` from `@x402/evm/exact/server`
- `@x402/paywall` is an optional peer dependency, left out: this endpoint serves agents, not a browser paywall
- networks are CAIP-2 (`eip155:84532`), not the old `"base-sepolia"` strings

Routes: `GET /brief` is paid; `GET /health` and `GET /ledger` are free. The 402 body is `{"error":"Payment required"}` only, so the brief never leaks in the challenge.

Money rules, in `bookSettlement` and unit tested:

- revenue is booked in `onAfterSettle`, never in the route handler, so nothing is recorded until the facilitator confirms settlement
- the ledger key is the settlement transaction, so a replayed settlement is idempotent
- the settled amount counts as USDC minor units only when the asset is the expected USDC; atomic units of another token are refused with `wrong_asset`
- entries are tagged `testnet` or `mainnet`, never `sim`
- `loadConfig` refuses mainnet unless `MAINNET_ENABLED=true` and refuses an unknown network rather than defaulting

Also moved: `loadLatestBrief` now lives in `src/briefstore.ts` in core, shared by `demo-live.ts` and the API instead of being duplicated. It uses `node:fs`; core already used `node:crypto`, so node builtins in core are not new.

Answered by the first real sale, with onchain evidence: **the buyer needs no testnet ETH**. `eth_getTransactionByHash` on the settlement shows `from` = `0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf`, which is the facilitator address x402.org advertises in its own `/supported` response, not the buyer. `to` is the USDC contract with `value` 0, consistent with the facilitator submitting a signed EIP-3009 `transferWithAuthorization` and paying the gas itself. A buyer therefore needs only USDC. Do not assume this holds with a different facilitator.

Verified facts worth keeping:

- `https://x402.org/facilitator/supported` advertises `exact` on `eip155:84532` and no other EVM network. This confirms the earlier note that the free facilitator is testnet only and mainnet needs a different one.
- USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's contract address list, read 21 Nov 2026). The same page gives Base mainnet as `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, matching the address already verified here, which is what makes the testnet one credible. The running server's own challenge then resolved `$3.00` to amount `3000000` against that asset with `extra {name: USDC, version: 2}`, confirming it independently.
- `npm audit --omit=dev` is clean with the new dependencies. The 6 reported vulnerabilities are dev-only.

Price decided 21 Nov 2026: `$0.01` by default, down from `$3.00`, so a demo buyer needs almost no test USDC. This has a consequence worth knowing before wiring real revenue into the investing loop. With the demo mandate (reserve target 2.00, opening reserve 1.50, invest share 5000 bps), a single `$0.01` sale is less than the model cost of the brief, so surplus is zero and nothing is invested. The `$3.00` figure in `demo-live.ts` is what makes that scene work. Before joining the two, either lower `reserveTargetUsdc` for the demo mandate or accumulate enough sales; do not quietly raise the price back. **Superseded 23 Nov 2026**: the price is now `$0.25` and the reasoning is in the pricing entry near the end of this document. It was raised loudly, with the reason recorded, because at `$0.01` the agent could never invest at all.

Buyer client added: `apps/api/src/buy.ts`, run with `npm run buy -w @surplus/api`. It prints the challenge, pays, prints the settlement, then reads `/ledger` to show the booked sale. Verified from the installed packages: `wrapFetchWithPaymentFromConfig` and `decodePaymentResponseHeader` from `@x402/fetch`, client-side `ExactEvmScheme` from `@x402/evm` root (not `/exact/server`, which is the seller side), `privateKeyToAccount` from `viem/accounts`. The buyer key is read from `.env` as `X402_BUYER_PRIVATE_KEY` and never printed or logged.

Fixed 21 Nov 2026, found by Siddhant on the first run: `npm run api` failed with "X402_PAY_TO is not set" even though it was set. npm runs a workspace script with the workspace as its cwd, so `existsSync(".env")` in `apps/api/src/index.ts` was testing `apps/api/.env`, silently skipped loading, and the missing value looked like a config mistake. `BRIEFS_DIR=docs/briefs` had the same latent fault and would have resolved to `apps/api/docs/briefs`. Both now go through `src/paths.ts`, which derives `REPO_ROOT` from `import.meta.url` rather than the cwd; `required()` also names the exact `.env` path it looked in. Four regression tests in `test/paths.test.ts`. The lesson generalises: anything in `apps/*` must not resolve paths against the cwd.

Next on this milestone:

1. Done: the paid request settled and booked correctly (details above).
2. Done, see below.
3. Done, see below.

## Ledger persistence, closed 21 Nov 2026

The ledger is now append-only JSONL on disk, one entry per line, in `src/ledgerstore.ts`. JSONL fits an append-only ledger: a new entry never rewrites an earlier one, the file is its own audit trail, and a reader replays it in order. Amounts are stored as decimal strings of minor units, never JSON numbers, so money cannot pass through a float.

Two bugs found on the way, both of which persistence would have been built on top of:

1. `Ledger.replay` in core spread `txHash` and `idempotencyKey` into `memo` instead of their own fields, a copy-paste error. So a replayed ledger lost the onchain link and, worse, lost its dedup index: the same settlement arriving again after a restart would have booked a second time. The existing replay test only compared balances, which do not depend on those fields, which is why it survived. Fixed, with tests that fail against the old code (one asserted `expected 2 to be 1` on the duplicate).
2. `Treasury` records events (`REFUSAL`, `PROPOSAL_CREATED`, `APPROVAL_RECORDED`) as entries with no lines, and the first version of the parser rejected an empty `lines` array. Fixed and covered.

How it hangs together:

- `JsonlLedgerStore.loadLedger()` replays the file into a `Ledger`, which the API hands to `Treasury` through its existing `ledger` option.
- `flushNewEntries(ledger, store, lastId)` appends only entries newer than the high-water mark and returns the new one. Entry ids run from 1 in order, so the id is the cursor. The settle hook flushes immediately after booking, so a crash can only lose an entry whose onchain payment would then need reconciling by hand.
- The sales list is derived from the ledger with `salesFromLedger`, not stored twice, so the two cannot disagree after a restart. `receivePayment` gained an optional `memo` and the API passes the brief id, so a persisted entry says what was sold.
- Reading money back off disk fails loudly: a truncated final line, a float amount, an unknown type or mode, or a gap in the entry ids all throw rather than being guessed at or silently skipped.
- `LEDGER_PATH` defaults to `data/ledger-<mode>.jsonl` at the repo root, one file per mode so a testnet and a mainnet ledger can never share one. `data/` is gitignored.

Verified live, not just in tests: fresh ledger, real purchase, kill, restart. The restart reported `1 entries restored, 1 sales, cash 0.010000 USDC` and `/ledger` returned the entry with its `txHash` and the brief id. A second purchase appended as id 2 rather than overwriting. Sale transactions `0x137ee4ca...` and `0xaabf0aed...`.

## Treasury state restored from the ledger, closed 21 Nov 2026

The limit left by the persistence milestone is fixed: `Treasury` now rebuilds its derived state from the ledger, so a restored ledger gives a correct treasury rather than one that thinks every brief earned nothing.

The blocker was that the ledger had no structured record of what a movement was *for*. A memo is free-form, so attributing revenue meant parsing prose. `PostInput` and `LedgerTx` therefore gained an optional `briefId`, which `Treasury` sets on `PAYMENT_RECEIVED` and `COST_ACCRUED`, and `bookSurplus` sets on `RESERVE_TOPUP` and `SURPLUS_ALLOCATED`. It persists and replays like any other field.

`rebuildFromLedger` runs automatically in the constructor whenever the injected ledger has entries, so a caller cannot forget to ask for it. It restores:

- `seenPayments` and `seenCosts`, from the `pay:` and `cost:` idempotency key prefixes
- per-brief `revenue` and `costs`, from the cash line of each attributed entry
- the settled `SurplusResult`, where `reserveTopUp`, `surplus`, `investable` and `retained` come straight from the booked lines, and `net` and `shortfall` follow from revenue minus costs

Why restoring the settled result matters, and it is the sharp edge here: after a restart the reserve is already at target, so recomputing a settlement would see no reserve gap and report a larger surplus than was actually booked. Worse, `bookSurplus` would then try to post that different result under the same idempotency key. Verified against the pre-fix code, that throws `Idempotency key brief-b1:alloc reused with different content`. So the old behaviour was not merely wrong numbers, it would break the settle path after any restart. Five tests cover this, all four of the main ones confirmed failing against the old code.

A brief that settled with net at or below zero books nothing and leaves no trace, so it is treated as unsettled on restore. Re-settling it books nothing again, so this is harmless.

Backward compatibility: entries written before `briefId` existed still load, and their payment ids are still restored so they cannot be booked twice, but their money is not attributed to any brief. The two demo sales already in `data/ledger-testnet.jsonl` are in that state. Deleting that file gives a clean start; the onchain record is permanent either way. Pinned by a test.

Still in memory and not restored: `records`, the proposal and approval state machines. That is correct for now because an approval is bound to a quote and expires in minutes, so a proposal should not survive a restart. Revisit it with the EIP-712 signature milestone.

## Real revenue wired into the investing loop, closed 21 Nov 2026

`demo-live.ts` now takes its revenue from the paid endpoint's own ledger instead of a made-up `$3.00`.

`realizedSales` and `realizedRevenue` in `src/ledgerstore.ts` are the single answer to what the agent actually earned, and both the endpoint's `/ledger` and the investing loop read it, so the two cannot disagree. Only `PAYMENT_RECEIVED` entries carrying a settlement transaction count: a payment with no transaction never landed onchain and is not proven revenue. The API's `salesFromLedger` now delegates to it.

Deliberate separation of books. The investing loop still runs in its own `sim` ledger and reads the testnet ledger read-only, because a simulated fill must never be written into the book that records real money. The mirrored revenue entry names the transactions it stands for, so the provenance is checkable rather than asserted. `LEDGER_PATH` points the loop at the endpoint's ledger and defaults to `data/ledger-testnet.jsonl`.

What the real run shows right now, and it is the correct answer rather than a bug:

```
Revenue from the paid endpoint: 2 real sale(s) in data/ledger-testnet.jsonl
  0.010000 USDC [testnet] tx 0x137ee4ca...
  0.010000 USDC [testnet] tx 0xaabf0aed...
Revenue 0.020000 (REAL), real model cost 0.021188, net -0.001188, surplus 0.000000, investable 0.000000

Nothing to invest, and that is correct. Why:
  the brief cost 0.021188 and earned 0.020000, a shortfall of 0.001188
```

Two sales at `$0.01` do not cover a `$0.021188` brief, so the agent invests nothing. The script explains which rule stopped it (shortfall, reserve still below target, or nothing left after the invest share) instead of printing an empty allocation. `--simulate-revenue` rehearses the investing path on a labelled simulated `$3.00` sale; that path still produces 12 legs merged into 8 swaps and reconciles clean.

Arithmetic for a demo where the whole chain is real, worth getting right before recording. With the demo mandate (opening reserve 1.50, reserve target 2.00, invest share 5000 bps, `minTradeUsdc` 0.05) the reserve takes the first 0.50 of net, half of what is left is investable, and legs below 0.05 are dropped as `below_minimum`. Investable needs to be about 1.05 for all 12 legs to place, which needs roughly 2.63 of revenue. So:

- at `$1.00` a brief, 3 real sales give investable about 1.24, which is the known-good 12-leg run
- at `$0.01` a brief it would take about 150 sales, so the current price cannot demonstrate the investing path
- lowering `minTradeUsdc` would be the wrong fix: it exists because gas is 2 to 4 percent of a 0.10 leg

Recommendation: set `BRIEF_PRICE_USD=$1.00` for the recorded demo and make three real purchases, keeping `$0.01` for cheap functional testing. Do not lower `minTradeUsdc`. **Superseded 23 Nov 2026**: the default is now `$0.25`, derived from cost rather than picked for a demo, and the reserve target moved to `$0.42` of runway. Keeping `$0.01` for testing is still wrong for the same reason it was wrong in production: it is below what a brief costs.

## Investing endpoints, 21 Nov 2026

The investing loop now has an HTTP surface in `apps/api`, so it is no longer script-only. Engine in `src/investing.ts`, auth in `src/owner.ts`, routes in `src/server.ts`. The UI is deliberately not started.

Routes, all gated: `GET /mandate`, `POST /invest/sync|propose|approve|execute`, `GET /invest/proposals|ledger`.

Decisions worth keeping:

- Propose, approve and execute are three separate calls. Nothing approves on the owner's behalf, and `execute` on an unapproved proposal throws rather than proceeding.
- `OWNER_TOKEN` has no default and no open mode: under 16 characters and the server refuses to start. Comparison is constant time. It is a shared secret, NOT the owner's signature on a trade, and `src/owner.ts` says so at the top so nobody mistakes it for the EIP-712 milestone being done.
- Market data is fetched per call rather than cached, because a quote older than 25 s is refused by the gates and the trusted set can change.
- `MarketData` is injected, so the 44 API tests exercise propose, approve, execute and the gates with no network.
- Proposals are deliberately not persisted. An approval binds to a quote and expires in minutes, so a proposal must not outlive the process. `ids()` tracks them in a set rather than parsing them back out of ledger memos.

Two bugs of mine that the work surfaced:

1. The first test double for quotes was wrong, not the code: it invented `at` and `price` fields, while the real `Quote` carries `timestamp` in unix seconds and the price is derived by `priceOf` as `amountIn * 10^decimals / amountOut`. The gates correctly blocked with "quote is NaNs old" and a 65734999999999990000 bps NAV deviation. The double now builds quotes from the real relation, so the gates do real work in tests.
2. Live `/invest/ledger` returned `reconcile: {ok: false, issues: ["negative balance on cash.operating"]}`, and it was right. A brief's model cost is spent before any revenue arrives, so with revenue of 0.02 against a cost of 0.021188 the operating cash went negative: the books were reporting money that was never there. The missing piece was the owner's working capital. `OPENING_FLOAT_USDC` (default 1.00) is now booked once against `equity.opening`, idempotent on the amount so a restart cannot fund the agent twice. Tested both ways: with the float reconciliation passes, without it the negative balance is reported rather than hidden.

Verified live against the running server: unauthenticated and wrong-token calls both 401; `/invest/sync` mirrored the 2 real sales (20000 minor units); `/invest/propose` correctly refused with "nothing investable" because real revenue is still below the brief cost; `/mandate` served version 1 with its hash; `/invest/ledger` reconciles clean with the float in place. The full propose, approve and execute path over HTTP is covered by tests with a faithful market double rather than live, because real revenue cannot yet fund an allocation.

The backend items from this list are all closed. What remains is the UI and the submission work in "Next milestones".

## On-demand research, 21 Nov 2026

`POST /research` generates a brief for the buyer's own themes. Service in `apps/api/src/research.ts`, priced separately from the cached `GET /brief`.

The economics, which drove the design: generating costs real money per request, and the old `$0.01` price was below the `$0.021` cost of a brief. So `RESEARCH_PRICE_USD` defaults to `$2.00`, `RESEARCH_MAX_USD` caps what one brief may cost, and `loadConfig` refuses to start when the cap exceeds the price. That check is the only place the mistake can be caught before a buyer has already paid for a brief sold at a loss. Verified live: the 402 challenge quotes amount `2000000`.

The cache is what makes this viable at all. Requests are keyed by a hash of the normalized theme spec (ids sorted, text lowercased, keywords sorted), so two buyers asking the same question inside `BRIEF_MAX_AGE_SECONDS` share one generation and the second costs nothing. The response says which happened.

Payment timing, verified from the SDK types rather than assumed: the `exact` scheme's flow is `authorization`, with phase flags `verifyBeforeHandler` and `settleAfterHandler`, and `handler_threw` is a listed verified-payment cancellation reason. So payment is verified before the handler and settled after it returns, and a handler that throws cancels the payment. The handler therefore lets generation failures propagate instead of swallowing them: the buyer is not charged for a brief they never received. Invalid themes are refused with 400 before any model call.

Buyer themes are untrusted input, because they land in the prompt next to the filings. `normalizeThemes` rejects angle brackets (so a description cannot forge a `</source>` tag and escape the untrusted block), newlines and control characters, and oversized or numerous themes. That is hardening, not the defence: the defence is verification, which a buyer cannot talk their way past because a quote has to exist verbatim in a real filing.

`budgeted` moved out of `demo-research.ts` into core as `budgetedLlm`, so the script and the API share one spend guard.

### A real bug this found, worth remembering

An intermittent test failure turned out to be a production bug, not a flake. The failing assertion reported `calls: 2, files: 1`: both briefs generated, but only one file on disk. `briefId` was `brief-<ISO timestamp>`, which has millisecond resolution, so two requests landing in the same millisecond produced the same id and the second `writeFileSync` overwrote the first. Two consequences, the second worse than the first: a buyer's brief and its audit trail are destroyed, and because the investing book keys model costs as `llm-<briefId>`, the two briefs share a cost key and `accrueCost` silently drops the second brief's cost as a duplicate. Ids now carry a random suffix alongside the timestamp. Pinned by asserting two distinct files and two distinct brief ids.

Two of my own test mistakes along the way, both worth avoiding: running `npx vitest run test/research.test.ts` from the repo root matches that path in *both* workspaces and runs `packages/core`'s file too, which made the results incoherent; and module-level mutable state in a test file (a call counter, a temp directory) is visible to any test running alongside it. Both the counter and the directory are now per-test.

Known limit: the investing book books the model cost of `readBrief()`, which is the newest brief. With many generated briefs, costs for the others are not booked, so total costs understate real spending. Fixing it properly means per-brief surplus accounting rather than a single settled brief; it is not wired yet.

## Mandate versioning, 21 Nov 2026

The mandate is now really the owner's and really versioned: persisted in `packages/core/src/mandatestore.ts`, changed through `POST /mandate`, with the hash chain verified on every load.

- `MandateStore.adopt` takes stored versions only after re-validating the terms and recomputing the chain. `restoreMandateStore` and `JsonlMandateStore.loadStore` build on it.
- `openMandate` creates version 1 from the code's terms **only when nothing is stored**. After that the stored mandate is authoritative and the code's terms are never applied again, so a deployment cannot quietly reset the owner's constraints to the defaults. That is the rule "the agent never changes user constraints" applied to deployment, and it has a test.
- `POST /mandate` takes a partial update: unsent fields carry over. An unknown field name is refused rather than ignored, because a silently ignored typo is a limit the owner thinks they changed. Amounts are decimal strings, never floats. The response lists what changed and notes that outstanding approvals are bound to the previous version.
- `buildServer` cannot change the mandate by itself: `index.ts` passes an `updateMandate` function, and without it the route returns 409. The agent has no path to loosening its own constraints.
- One `MandateStore` is now shared by the server and the investing engine. Before this each built its own, so both sat at version 1 and would have diverged the moment the owner changed a term. Harmless then because the terms were identical, wrong as soon as updates existed.
- The mandate routes were moved out of the investing-engine block: the mandate is the owner's constraint set, not an investing feature, so it is served whether or not an engine is wired in.

Verified live: v1 created from the initial terms; `POST /mandate` with `{maxSlippageBps: 50, reserveTargetUsdc: "0.50"}` produced v2 chained to v1 and reported `reserveTargetUsdc: 2000000 -> 500000, maxSlippageBps: 100 -> 50`; a misspelled `maxSlipageBps` was refused with 400; `/mandate/history` reported `chainVerified true` across both versions; a restart loaded v2 and kept the owner's terms rather than the code's.

Tamper check, run against the real file: raising `maxTradeUsdc` from 1.00 to 500.00 on disk while leaving the hash alone makes the server refuse to start with "mandate version 1 hash does not match its terms; the stored mandate was altered". The file was restored afterwards.

Also fixed on the way: `packages/core/src/mandate.ts` imported `check` from `fast-check`, which is unused and a devDependency, so production domain code depended on a dev-only package. esbuild elides it today, so it was latent rather than breaking, but it would fail a production install or any tool that resolves imports without eliding. Removed.

Lesson for whoever drives this next: `pkill -f` repeatedly killed my own shell mid-command (exit 144), which silently skipped the steps after it, including a tamper test I thought had run and passed. Kill a dev server by port or recorded PID, not by a pattern that can match the command doing the killing.

## EIP-712 owner signature on approvals, 21 Nov 2026

Approving a trade over HTTP now requires the owner's EIP-712 signature. The bearer token only decides who may reach the route; it no longer authorizes anything.

- `packages/core/src/eip712.ts` builds the typed data and is deliberately free of crypto dependencies, so the agent, a wallet and a reviewer can all derive the same bytes. Signing and recovery live in the app layer.
- `apps/api/src/signature.ts` verifies with viem's `verifyTypedData`. viem moved from devDependencies to dependencies; `npm audit --omit=dev` is still clean.
- `OWNER_ADDRESS` is required and the server refuses to start without it. There is no unsigned approval path and no half-secured mode.

The flow avoids a clock-skew trap. `/invest/propose` returns `toSign`: the exact payload including an expiry the server chose, which it remembers. Recomputing the payload at approval time would drift by the round trip and no signature would ever match. `/invest/approve {id, signature}` verifies against that stored payload.

What the signature binds: `proposalHash` (cannot be moved to other legs), `mandateVersion` and `mandateHash` (cannot survive a mandate change), `maxUsdcIn` (cannot authorize more spend), `expiresAt` (cannot be replayed later), and `chainId` in the domain (a testnet signature is not valid on mainnet). The owner address comes from config, never the request: a caller supplying the address it signed with would be authorizing itself. `maxUsdcIn` and both hashes are always computed by the agent, never taken from the caller, and a supplied `expiresAt` is clamped to the mandate's `approvalExpirySeconds` so a signature cannot widen the owner's own window.

`apps/api/src/sign-approval.ts` (`npm run approve -w @surplus/api -- <proposalId>`) signs from the command line as a stand-in for a wallet UI. The key is read from `.env` as `OWNER_PRIVATE_KEY` and never printed. A throwaway owner wallet was generated for the demo and its address is in `.env`.

Where it is enforced, stated plainly: `Treasury.approve` in core still accepts an unsigned approval, because `demo-sim.ts` and `demo-live.ts` use it. The requirement lives in `InvestingEngine.approve`, which refuses without a verifier and a valid signature. Do not assume core enforces it.

Verified live against the running server: the server reports the owner address and chain on boot; the token alone is refused with 400 "signature is required"; a junk signature for an unoffered proposal is refused; and `npm run approve` loads the owner wallet and reports the real blocker. The signed happy path and every rejection are covered by tests that sign with a real viem account rather than a stub: an impostor's signature, a signature made for chain 8453 instead of 84532, a signature over a tampered `maxUsdcIn`, an unsigned approval, and a server with no verifier are each refused, and the accepted path returns the recovered signer.

A live signed propose, approve and execute still waits on real revenue above the brief cost, which is the pricing decision in the integration section, not a code gap.

Also fixed: `packages/core/src/mandate.ts` imported `check` from `fast-check`, unused and a devDependency, so production domain code depended on a dev-only package.

## Per-brief cost and revenue attribution, closed 21 Nov 2026

`syncRevenue` used to book only `readBrief()`'s cost, which is the newest brief, and mirror all revenue as one lump attributed to that same brief. Both are now per brief.

- Every saved brief's model cost is booked exactly once, keyed `llm-<briefId>`. A brief costs real money whether or not anyone buys it, so leaving the others out understated spending.
- Each sale is mirrored on its own, keyed `mirror:<txHash>`, tagged with that transaction, and attributed to the brief the sale actually bought, which the sales ledger records in its `briefId` field.
- Every brief that earned something is then settled in turn. Each sees the reserve as it stands, so the first fills the reserve gap and later ones go to surplus, which is the right order of priority. A test pins that ordering.
- Already-mirrored sales are recognised from the transaction on each stored entry, so a restart picks up only new sales. Tested.

How much it mattered, measured on the real data: the old code booked 0.021188 USDC of model cost. The new code books 0.105683 across the five saved briefs, so spending had been understated roughly fivefold. Against 0.020000 of revenue, the agent is clearly underwater, which is the truth the books should show.

Legacy data needed a decision rather than a guess. The old lumped entry carried no transaction, so which sales it covered cannot be recovered, and mapping it onto per-sale ids would either double count or lose revenue. The engine now refuses to start on such a book, with a message naming the file and saying it is simulated and regenerable from the sales ledger and the saved briefs. The stale `data/ledger-invest-sim.jsonl` was backed up to the scratchpad, deleted and regenerated; the real sales book was not touched.

Sales written before attribution existed carry no brief id. Their revenue is kept under the brief id `unattributed` and `/invest/sync` reports the count, so the gap is visible instead of being silently assigned to the newest brief. The two real sales are in that state: `unattributedSales: 2`.

Live after the change: `briefsCosted: 5`, `revenueUsdcMinor: 20000`, `costsUsdcMinor: 105683`, `investableUsdcMinor: 0`, and `/invest/ledger` reconciles clean with cash 0.894317, reserve 0.020000, expense.llm 0.105683 against the 1.000000 float.

### One design question this surfaced, for Siddhant

Per-brief settlement means a brief that sold well can produce investable surplus while other briefs lost money, because each brief is settled against its own revenue and costs. The whole-book position is still visible (`cash.operating` covers everything and reconciliation refuses to let it go negative), and the reserve target absorbs some of it, but there is no rule today that says "do not invest while total costs exceed total revenue". Right now that is moot because investable is zero, and it is a mandate question rather than a bug, so nothing was changed. Worth deciding before mainnet.

## Review fixes, 21 Nov 2026

A full-project review found nine real defects. All are fixed, each with a regression test that fails against the old code. Tests went from 234+85 to 244+100.

**H1, the worst one.** `settleBrief` cached its first result and returned it forever, so every sale of a brief after the first sat in operating cash and never became investable. Reproduced: a 1.00 sale then a 5.00 sale left investable unchanged at 0.24 with only two sweep entries. Settlement is now incremental: `sweepAvailable` in `src/surplus.ts` splits whatever is newly available, `settleBrief` tracks `sweptRevenue`/`sweptCosts`/`carried` per brief, and the idempotency key covers the cumulative totals so a repeat call books nothing. A brief that is behind carries the deficit so later revenue makes good the loss before anything is swept, and the carry survives a restart.

**H2.** A signature made under one mandate was accepted under another. The engine verified against the payload it offered, then `Treasury.approve` rebuilt the recorded approval from the *current* mandate, so the `mandateVersion` and `mandateHash` in the signed message were never enforced. Reproduced: signed under v1, recorded as v2. Note the first attempt appeared safe because changing `maxSlippageBps` happens to trip `checkProposal`; any field the policy engine does not inspect went straight through. Now the engine refuses when the mandate has moved and drops the stale offer, and `Treasury.approve` takes an `expect` approval and refuses on any field mismatch, so the domain layer enforces it too.

**H3 and H4, one root cause.** Buyer-commissioned briefs and the owner's catalogue shared `docs/briefs` with newest-wins semantics. That meant the 0.01 cached route served whatever a buyer had just paid 2.00 to commission, including their own thesis, and the investing loop fed the allocator a buyer's themes and threw `Theme "x" has no target in the mandate`. Buyer work now lives in `CUSTOM_BRIEFS_DIR` (default `data/briefs-custom`), served to nobody else; `propose` filters to themes the mandate funds and reports the skipped ones instead of throwing; cost accounting still covers both directories, because a buyer's brief cost the agent real money.

**M1.** The settle hook asked for the newest brief rather than the one served, so every cached research sale was attributed to the wrong brief. An `AsyncLocalStorage` context now carries the served brief id from handler to hook, and with none it records `unattributed` rather than guessing.

**M2.** The opening float was keyed on its amount, so changing `OPENING_FLOAT_USDC` added a second capital entry (1.00 then 2.00 gave equity of 3.00). Working capital is now a running total: only the increase is booked, and a reduction is refused rather than rewriting history.

**M3.** One truncated brief file took down the paid route, the research cache and the investing loop. `scanBriefs` skips unreadable files and returns `problems`; `/invest/sync` reports them as `unreadableBriefs`, because a skipped brief is a model cost missing from the books.

**M4.** Two identical simultaneous research requests both missed the cache and both generated, and the spend cap was per call so N concurrent requests could spend N times it. Identical requests now share one in-flight promise, and `RESEARCH_TOTAL_MAX_USD` (default 10.00) caps spend for the life of the process.

**M5.** `maxCompanyBps` was enforced per allocation, so successive proposals could build a position far past it (two 1.00 allocations at a 50 percent cap put 100 percent into one token). `allocate` and `checkProposal` now take `held`, and the engine passes the `positions.*` balances, so the cap limits total exposure.

**M6.** Only the LLM clients had request deadlines. EDGAR, the Coinbase token API, DexScreener and KyberSwap could hang forever, which on `/research` means hanging while holding a verified payment. All outbound calls now use `AbortSignal.timeout` with a 15 s default (`HTTP_TIMEOUT_MS`).

Also fixed: uninvested money now names the constraint that actually bound rather than any slot's reason (L1); a zero or negative NAV counts as missing instead of producing an Infinity deviation (L2); `GET /ledger` needs the owner token unless `PUBLIC_LEDGER=true`, because it is the operator's whole financial history (L4); proposal ids are bounded to 64 safe characters since they land in persisted memos (L5); and `demo-live.ts` resolves its paths from the repo root rather than the cwd (L6).

### Still open after the review

- `swapPlan` is computed and asserted but `Treasury.execute` still fills per leg, so the gas saving it exists for is not realized. Unchanged, and no test claims otherwise.
- `reconcileInternal` validates by replaying through the same `Ledger.replay` it is checking, so it is partly circular. It catches serialization and restore faults, not a systematic fault in `post`.
- Whether a non-2xx from `/research` cancels or settles the payment is still unverified. It was inferred from the SDK's `authorization` flow and `handler_threw` cancellation reason, never exercised with a real failing paid request. If a 400 settles, buyers are charged for rejected theme input.
- There is no lint configuration and no build step; `tsc --noEmit` is the only static gate.
- Quotes are fetched sequentially with a 500 ms gap and all judged against one `now` against a 25 s freshness limit, so a large token set on a slow network could age the first quote out. Not reproduced, worth watching.

## The frontend plan, agreed 21 Nov 2026

Siddhant's instruction: "I don't want a project that is just made well-enough to be presented to the judges. I want a full working application that completes the process end-to-end." Two earlier recommendations were retracted as demo reasoning: the public page now transacts rather than explains, and owner auth is wallet sign-in rather than a bearer token typed into a browser.

### The fact that dominates the plan

The two halves of Surplus are on different chains. Checked 21 Nov 2026 with `eth_getCode`:

```
NVDAc on Base mainnet  (8453):  0xef   deployed
NVDAc on Base Sepolia (84532):  0x     nothing there
KyberSwap endpoint in the code: /base/ mainnet
```

Selling runs on Base Sepolia because that is the only EVM network the free x402 facilitator serves. The tokenized stocks exist only on Base mainnet. Testnet USDC cannot fund a mainnet swap and cannot be bridged, so the loop cannot close with real money until both halves are on mainnet. That needs a paid facilitator, real USDC, and eligibility advice that has been flagged unverified since day one. Decision: build every path mainnet-capable behind `MAINNET_ENABLED`, keep running Sepolia plus simulated fills, and treat real swaps as a gated release rather than a milestone.

### Settled decisions

- Audience: the owner's desk **and** a public face that really sells.
- Real and wired to the live API, not fixtures.
- Visual direction: a lit navy stage with a coral bloom and fluted glass for the hero and the decision, calm flat navy for the working detail. Palette is Siddhant's 60/30/10: navy `#14213D`, cream `#F4EDE0`, coral `#FF6B5B` on the one action meant to be pressed. Mock in `apps/web/mock/approval.html`.
- Stack: Vite, React and TypeScript in `apps/web`, built to static files the Express app serves.
- Signing: the owner's browser wallet signs the EIP-712 payload. A server-side key would make the signature decoration rather than authority.
- Owner auth: wallet sign-in. `OWNER_TOKEN` stays for machine and CLI use and never reaches a browser.
- Buyer keeps their brief through a receipt page keyed by the settlement transaction hash. No accounts.
- `PUBLIC_LEDGER=true`: the book is the pitch. Revisit before mainnet, where it becomes a real disclosure.
- Close the swap-plan gap: execute one swap per `SwapOrder` while the ledger keeps one entry per leg.
- New mandate term: do not invest while lifetime costs exceed lifetime revenue.

### Dates

Today is Sat 21 Nov 2026. Submissions close Sat 5 Dec 2026 (UTC). Target submit Fri 4 Dec (note: 4 Dec is a Friday, not a Thursday). Thirteen days, four of them weekend. The agreed scope is roughly 18 to 20 solo days, so the plan is sequenced for every checkpoint to be a whole working product and for the most likely casualties to be last and severable.

| Dates | Phase | What ships |
|---|---|---|
| Sat 21 to Sun 22 Nov | Foundations and de-risk | Done 21 Nov: Vite, React and TS in `apps/web`, design tokens lifted from the mock, spike passed. Remaining: Express serves `dist` |
| Mon 23 to Wed 25 Nov | The owner desk, real | Done 21 Nov: wallet sign-in, Express serves `apps/web/dist`, desk wired to `/invest/*` with browser EIP-712 signing. Remaining: see the proposal path in a browser once there is surplus |
| Thu 26 to Sat 28 Nov | The storefront, real | Done 21 Nov: storefront, in-browser purchase, receipts. Remaining: a real browser purchase with a funded wallet |
| Sun 29 Nov to Tue 1 Dec | Running for real | Done 21 Nov: underwater term, real swap execution built and gated, graceful shutdown, `docs/DEPLOY.md`. Remaining: the VPS itself, which needs Siddhant's accounts |
| Wed 2 to Thu 3 Dec | Hardening and the real run | Errors, retries, empty states, mobile, accessibility. Re-check the Quest rules and base.org/stocks. Raise the price, make real purchases, let the loop run. Record |
| Fri 4 Dec | Submit | Target |
| Sat 5 Dec | Buffer | Hard close. Nothing planned into it |

Checkpoints, each a complete product:

- Wed 25 Nov: the whole investing loop runs from a browser, signed with the owner's wallet.
- Sat 28 Nov: a stranger with a funded wallet buys a brief in a browser and keeps a receipt.
- Tue 1 Dec: it runs continuously at a public URL and has been selling for a day.

### Wallet sign-in, built 21 Nov 2026

`apps/api/src/session.ts`. The owner signs an EIP-712 `Login` message and gets an httpOnly, SameSite=Strict session cookie. `OWNER_TOKEN` stays for machine and CLI callers and never reaches a browser; `requireOwnerAccess` accepts either door. What stops the obvious attacks: the nonce is single use and expires in five minutes, the domain carries the chain id, the recovered address must equal the configured `OWNER_ADDRESS` which never comes from the request, and the cookie cannot be ridden from another origin. Sessions live in memory, so a restart signs the owner out, which is the safe direction. `COOKIE_SECURE=false` is needed only for plain-http local development.

Fourteen tests, signing with a real viem account rather than a stub: an impostor is refused, a nonce cannot be replayed, sign-out revokes, and the cookie never contains the token.

A bug worth recording, because the type checker was no help. Moving the auth block cut the `/auth/me` handler before its closing brace, so `app.use(paymentMiddleware(...))` and every route after it were nested inside that handler. It compiled, the owner routes still answered, and only the public routes vanished: `/health`, `/brief` and `/ledger` returned 404 while `/mandate` worked, which is the opposite of what a missing-route bug usually looks like. There is now a test that asserts the shape of the whole server, checking that no route answers 404, rather than testing one handler at a time.

### The owner desk, built 21 Nov 2026

`apps/web/src`: `api.ts` (typed calls), `wallet.ts` (injected provider), `SignIn.tsx`, `Desk.tsx`, `App.tsx`. Verified in a real browser against the live API, signed in with the owner wallet.

What it does. Sign in by signature, then sync revenue, ask for a proposal, sign it and execute, with the filing quote under every leg and the book underneath. The panel carries the mandate version and hash, the investable balance, the reserve, and a flag if the books stop reconciling. The clock counts the approval down because the approval really is expiring.

Decisions worth keeping:

- Nothing in the web app imports `@surplus/core` at runtime. Core reaches for `node:fs` and `node:crypto`, so a value import would break the browser build. Types come through `import type`, which is erased, and the money formatter is local. Keeping the desk off the x402 packages also dropped the bundle from 657 kB to 239 kB (75 kB gzipped).
- `wallet.ts` passes the server's typed-data payload to the wallet untouched. Rebuilding it client side would be a second implementation of the thing the signature pins down, and any drift would look like a signature the server rejects for no reason.
- A refusal is not an error. `POST /invest/*` answers with its reasons, and the desk shows them as a titled note rather than a toast that disappears. "Nothing to invest, and that is correct" is a first-class state with its own copy, because an agent declining to invest money it has not earned is the design working.
- New route `GET /invest/brief`, owner gated. The desk needs the claims and quotes behind each leg, and the owner must not have to pay their own paid route to see their own catalogue.

Seen working in a browser: the sign-in screen including the no-wallet state, the signed-in desk with live balances and the real book, and the "nothing to invest" refusal carrying the real figures (earned 0.020000 across 2 sales, spent 0.105683 on 5 briefs). A disabled primary action looked pressable in the first screenshot and now reads as inert.

Not yet seen in a browser: propose, approve and execute, because investable is zero until the price rises and real purchases are made. The engine paths behind them are covered by the API tests with a faithful market double. This is the one thing to exercise first on Wed 2 Dec.

### The storefront and receipts, built 21 Nov 2026

`apps/web/src/Store.tsx`, `Receipt.tsx`, `buy.ts`; `apps/api/src/receipts.ts` and the `/catalogue`, `/receipt/:id` routes.

**A correction to the plan.** During the grilling I said a settlement transaction is self-authenticating, because "only the person who made that payment knows it". That is wrong: settlements are public on Base, so anyone watching the seller's address could harvest hashes and read briefs they never bought. Receipts are therefore keyed on a random 24-byte id issued at purchase and returned only in the paid response. The transaction is stored beside it as proof the buyer can check, never as the way in. A test asserts that the transaction itself opens nothing.

How a receipt survives the payment flow. The id is minted in the handler, because settlement happens after the handler returns and the response has to carry the link before the transaction exists. The settle hook binds id, transaction and brief once the payment lands, using the same request context that already carries the served brief. If settlement never happens, the id was never stored and the link simply finds nothing, which is the right outcome for a payment that was cancelled.

Other decisions:

- The payment stack is a dynamic import. Reading the storefront costs 250 kB; the 421 kB of x402 and viem arrives only when someone decides to buy.
- `/catalogue` is the public teaser: price, network, themes, how many filings and facts, how much has sold. A test asserts it never contains a claim or a quote.
- An unknown receipt id and a malformed one get the same 404, so the route cannot be probed.
- A valid receipt whose brief is gone answers 410 and still shows the transaction, rather than pretending the purchase never happened.

Seen working in a browser against the live API: the storefront with real figures (3 themes, 13 facts, 10 filings, 2 sold, 0.020000 USDC earned) and the correct no-wallet state, and a receipt page rendering the real brief with its verbatim quotes and filing citations.

Two things found while verifying. The receipt data route and the receipt page both wanted `/r/:id`, so the browser got JSON instead of the page; the data route is now `/receipt/:id` and `/r/:id` belongs to the app. And `JsonlReceiptStore` reads its file once and caches, so a receipt written by another process is invisible until restart. That is correct for one process and worth remembering if it is ever run with more than one.

Not yet done: a real browser purchase with a funded wallet. The spike proved signing and submission work from a page, and the failure was only insufficient funds, so what remains is funding rather than code.

### Phase 3, built 21 Nov 2026

**The underwater term.** `MandateTerms.investOnlyWhenAhead` refuses a proposal while lifetime costs exceed lifetime revenue. Optional on purpose: `canonicalJson` drops undefined keys, so a mandate written before this term hashes exactly as it did and its stored chain still verifies. A test pins that, because adding a hashed field carelessly would make every stored mandate fail verification and the server refuse to start. The existing v2 mandate is untouched; new deployments start with it on.

Worth recording about the test: a single brief cannot be both profitable and leave the agent behind, so the first version of the test could never reach the check. The real shape needs a brief that sold well beside briefs that cost money and never sold, which is exactly the case the term exists for.

**Real swap execution.** `packages/core/src/swapbuild.ts` encodes a quoted route; `apps/api/src/executor.ts` sends it. One transaction per `SwapOrder`, which is what the merge in `swapPlan` was always for: gas once per token rather than once per theme. The build endpoint shape was read from KyberSwap's EVM swap API specification on 21 Nov 2026, not guessed: `POST /base/api/v1/route/build` with `routeSummary`, `sender`, `recipient`, `slippageTolerance`, `deadline` and `source`, answering with `data`, `routerAddress`, `amountIn`, `amountOut` and `gas`, and needing an `x-client-id` header.

This is the only code in the project that can lose money irreversibly, so it is built to refuse:

- it will not construct without `MAINNET_ENABLED`, a positive spend cap and a key
- `parseBuiltSwap` refuses calldata whose `amountIn` is not exactly what was quoted, whose router is not the pinned one, or whose expected output is below the agreed floor. That first check is the important one: calldata that moves more money than the owner approved
- balance and allowance are read before sending rather than discovered in a revert
- the approval is for exactly the order amount, never unlimited
- a fill is booked only from a receipt with status success; a submitted hash is not a fill
- the spend cap is enforced across the run and only charged once the chain confirms, so a failed send cannot eat it

`openExecutor` returns its reason rather than throwing, so the server starts and says plainly what it is doing. Verified live: `execution   simulated (no BASE_RPC_URL is set)`.

**Running as a service.** `SIGTERM` closes the listener, finishes requests in flight and exits, with a ten second ceiling. Cutting a paid request in half could leave a buyer charged by the facilitator with nothing written on this side. Verified by signalling a running process.

`docs/DEPLOY.md` covers the rest: why the disk is not optional, the systemd unit, TLS and why `COOKIE_SECURE` defaults on, what is in `data/` and what is lost without each file, backing up append-only files safely while the process runs, and the health and reconciliation checks worth polling.

**Not done, and it needs Siddhant.** The VPS, the domain and the certificate. Nothing was provisioned or bought.

### Decision gate, Friday 27 Nov

Mainnet go or no-go. Without eligibility advice and a CDP account in hand by then, mainnet is off for the submission and real swaps stay built but gated.

### What only Siddhant can do

- Mon 23 Nov: decide whether to pursue eligibility advice at all; it has lead time.
- Fri 27 Nov: CDP account and a funded throwaway wallet, if mainnet is happening.
- Wed 2 Dec: about 3 test USDC and the time to make the real purchases.
- Throughout: the commits.

### Phase 0 spike result, 21 Nov 2026: in-browser x402 works

Risk 1 is retired on day one. `apps/web/src/Spike.tsx` ran in a real browser against the live API:

```
bundle     @x402/fetch, @x402/core and @x402/evm loaded in the browser
signer     empty throwaway account
client     x402 client built for eip155:84532
challenge  402 received, wants 10000 of 0x036CbD53...
payment    signed in the browser and submitted; server answered 402
           {"error":"invalid_exact_evm_insufficient_balance"}
```

The account was generated fresh in the page and holds nothing, so a balance error is the pass: the bundle loaded, the challenge was parsed, the EIP-3009 authorization was signed in the browser and the facilitator evaluated it. Only funding separates that from a real purchase, and the Node client already proved the funded path.

Two supporting facts. None of `@x402/fetch`, `@x402/core` or `@x402/evm` imports a node builtin in its ESM build, and `vite build` produces a browser bundle with no polyfills. The client signer interface is `address` plus `signTypedData` and nothing else (`ClientEvmSigner` in `@x402/evm`), which an injected wallet satisfies directly, so moving from the spike's local account to a real wallet is a shim rather than a rewrite.

Conclusion: the storefront transacts in-page as planned. The bundle is 657 kB raw and 203 kB gzipped, mostly viem; worth code-splitting in the hardening phase, not now.

### The two risks still being watched

1. The bundle is heavier than it should be and the storefront is the page a stranger loads first. Split it in Phase 4.
2. Real swap execution is about three days and shares a phase with deployment. It is the piece to drop if anything slips; the application is still complete end-to-end without it provided simulated fills stay labelled everywhere, which they are.
3. Mainnet may never be lawful for Siddhant to enable. The plan does not pretend to resolve that.

## Pluggable persistence and Postgres, 21 Nov 2026

Why: Siddhant asked whether this could deploy to Vercel. It could not. Six places write while the agent
runs (the two ledger books, the mandate history, the receipts, a buyer's commissioned brief, and the
owner's session), and a serverless instance can be replaced between any two requests. The failure is not
a crash: a settlement written by one instance is simply absent for the next, the mandate quietly reverts
to the terms in the code, and a buyer's receipt link stops working. He chose to make persistence
pluggable rather than host it on a machine with a disk.

What exists now:

- `packages/core/src/storage.ts` holds the ports: `LedgerSource`, `LedgerSink`, `LedgerStore`,
  `MandateBackend`, with `openLedger`, `openMandateStore`, `openMandateFrom` and `flushNewEntries`.
  Everything above the port is async; the file implementations resolve immediately.
- Ports for the rest, in the API: `ReceiptStore` (`src/receipts.ts`), `BriefBackend` (`src/briefs.ts`),
  `SessionStore` (`src/session.ts`, with `MemorySessionStore` as the in-process implementation).
- `apps/api/src/pg.ts`: Postgres behind every one of those ports. Money is stored as the exact line the
  JSONL file would hold and read back through the same parser, so a row cannot mean something a line
  could not. Amounts stay decimal strings of minor units. Appends are idempotent on the identifying key.
  Nothing in the ledger or the mandate history is ever updated or deleted.
- `apps/api/src/backends.ts`: `DATABASE_URL` is the entire switch, and the startup banner names which
  storage is live. The owner's catalogue stays on disk in both modes; it is repository content and
  nothing at runtime writes to it.
- `apps/api/src/app.ts`: the assembly, extracted from `index.ts` so the long-running server and the
  serverless entry build exactly the same thing. `index.ts` is now the listener, the banner and shutdown.
- `api/index.ts` and `vercel.json`: the serverless deployment. One assembly per instance, not per
  request; a failed assembly is not cached, so a database that was briefly unreachable does not leave an
  instance serving errors until the host recycles it.
- `npm run db:import -w @surplus/api` copies the existing books into Postgres, reads them back to check
  the entry ids, settlement transactions and idempotency keys survived, and never modifies the files.
  A dry run prints the plan; `-- --apply` writes.

Verified against a real Neon Postgres 18.7, in a disposable schema that is dropped afterwards: 25 tests
covering the ledger (round trip, string amounts, retried flush, two books kept apart, a hole in the ids,
a row edited in the database), the mandate (chain verified, same version twice accepted, a different
version at the same number refused, version 1 created only when nothing is stored), receipts, briefs,
sessions, and the whole server restarted on the same database. Core 256 tests, API 163, typecheck clean,
and both the long-running server and the serverless handler answer 200 / 402 / 401 / 404 on the routes
that should.

### Three things this turned up, worth keeping

1. A ledger file or book whose *first* entry was missing used to load as a shorter but apparently intact
   ledger, because the contiguity check only compared each entry with the one before it. Replay would
   then carry on from whatever id it found, with the missing money simply absent. Both implementations
   now require the first entry to be id 1. Fixed in `parseLedgerFile` as well, with a test.
2. A transaction-mode connection pooler reuses one server connection across clients and does not reset
   session state reliably: a `search_path` set by one client leaked into the next, which is how the first
   test run wrote its tables into `public`. The app therefore never sets `search_path` and uses whatever
   the role's default is. The tests pass the schema as a startup parameter (`-c search_path=...`) on the
   direct, unpooled endpoint, because both alternatives fail silently: `connection: { search_path }` is
   dropped by the driver, and a `set search_path` statement is lost the moment the driver reconnects.
3. Tests that shared one schema were not independent, and the symptom was not a clear failure but wrong
   counts. Each Postgres test now creates and drops its own schema.

### The live database, 21 Nov 2026

A Neon Postgres 18.7 is the agent's store now, and the books were imported into it:

```
sales:   2 entries, 2 settled sale(s), cash 0.020000 USDC -> book "sales-testnet"   verified
invest:  9 entries                                        -> book "invest-sim"      verified
mandate: 2 versions, current v2 87eb5288a3bd                                        verified
```

The JSONL files are untouched and are the backup of what was imported. Verified on the running server:
`/health` reports `"storage": "postgres"` and 2 sales, `/catalogue` serves the brief, `/brief` answers
402, `/mandate` loads v2 with the chain verified, `POST /invest/sync` books through Postgres, and after a
full restart the investing book still holds exactly 9 entries with `reconcile.ok` true, with a repeated
sync adding nothing. `GET /health` now names the storage, because that is the one deployment mistake
that does not announce itself: the files keep working on a serverless host right up to the moment an
instance is recycled and a settlement turns out to be missing.

One environment note that cost an hour: `systemd-resolved` was returning REFUSED for the Neon endpoint
because the active link was the iPhone hotspot, whose resolver refuses that name, while 1.1.1.1 answers
it. Fixed by setting the Wi-Fi connection's DNS to 1.1.1.1 and 8.8.8.8. The tests carry their own
resolver fallback; the application deliberately does not, because silently rerouting DNS in an app that
holds database credentials is not a thing to do quietly.

### Deployed, 21 Nov 2026

Live at https://surplus-eosin-seven.vercel.app, Vercel project `surplus`, serving the Neon database.
Verified on the deployment: `/health` reports `"storage": "postgres"`, the catalogue brief and 2 sales;
`/catalogue` 200; `/brief` 402 with the same body the local server returns; `/mandate` 401 without
credentials and v2 with the owner token; `/ledger` 401 because `PUBLIC_LEDGER` is unset; `/invest/ledger`
9 entries with `reconcile.ok` true; the storefront renders and shows "2 sold, 0.020000 USDC earned" read
from Postgres, with no console errors. The cold-start log line reads:

```
Surplus assembled: storage postgres, root /var/task, catalogue /var/task/docs/briefs (5 brief(s)),
mandate v2, 2 sale(s) booked
```

Two host behaviours broke the first attempt, both making every API route 500 while the static site
served fine. Vercel transpiles a TypeScript function without bundling it, so the function is now bundled
by esbuild into `api/index.mjs` before upload (ESM, because the code uses `import.meta.url`, with a
`createRequire` banner because `debug` calls `require("tty")` dynamically). And `REPO_ROOT`, derived
from a module's own location, points above the deployment once the code is one bundled file at the root:
the serverless entry now sets `SURPLUS_ROOT` from the working directory first. That second one did not
announce itself, which is the lesson worth keeping: every route answered and `"latestBrief"` was simply
null.

Three private keys were deliberately not uploaded: `OWNER_PRIVATE_KEY` and `X402_BUYER_PRIVATE_KEY` are
only used by the local `approve` and `buy` CLIs, and `EXECUTION_PRIVATE_KEY` is absent so the deployed
agent cannot execute a real swap even if `MAINNET_ENABLED` were flipped by accident. `.vercelignore`
keeps `.env` and `data/` off the host.

## The research spend cap, fixed 22 Nov 2026

The lifetime model-spend ceiling (`RESEARCH_TOTAL_MAX_USD`) was a field on `ResearchService`, which is
rebuilt on every cold start. On serverless that made it a per-instance ceiling with nothing bounding the
number of instances: the guard read as "$10 for the life of the deployment" and meant "$10 each".

It is now counted from the stored briefs, through a new `BriefBackend.totalCostUsdcMinor()`, so every
instance reads the same total. Postgres sums it in a `cost_usdc_minor` column (added with
`alter table ... add column if not exists`, so the deployed database picked it up on the next start) and
returns it as a decimal string of minor units, keeping money off the float path. The directory backend
sums the files.

A generation in flight is not stored yet but has committed real money, so it holds a reservation of
`RESEARCH_MAX_USD` until the brief lands, released in a `finally` so a failed generation cannot hold the
budget for ever.

The first version of that reservation did not work, and the reason is worth keeping: the check called
`budget()` and then reserved, and returning from an async method is itself an await hop. Two requests
arriving together both read the total before either reserved, and both passed. The check and the
reservation are now one synchronous step with no `await` between them. The test that caught it needed a
model that could be held open: with an instant fake, the first generation finishes before the second one
looks, and nothing concurrent is ever exercised.

What this does not fix: two instances can still start a generation in the same instant, each reading a
total the other has not written yet. The overshoot is bounded by one brief's cap per instance, and every
generation is paid for at `RESEARCH_PRICE_USD`, which the config refuses to let fall below the cap. A
reservation table in Postgres would close it properly if that ever matters.

### A connection bug worth remembering, 22 Nov 2026

Neon became unreachable from Siddhant's laptop while the deployment kept working, and the cause was not
the network alone. Node tries the resolved addresses in parallel and allows each one 250 ms. From India
to `us-east-1` every IPv4 attempt takes longer than that, and on a network where IPv6 is unreachable
(`ENETUNREACH`, which one of his two networks does and the other does not) there is nothing left to
succeed, so the connection fails with `ETIMEDOUT` even though a plain blocking socket connects and the
server answers the SSL handshake. `openSql` now widens that window to 1500 ms (`widenConnectWindow`),
which fixes the application as well as the tests: a deployment sitting beside its database never sees
this, and a developer far from it sees nothing else.

Worth knowing for next time: a failure in the Postgres suites' `beforeAll` is reported by vitest as
"22 skipped" rather than as a failure, which reads like "no database configured". Check the output
above the summary before believing it.

## Paid-request durability, 22 Nov 2026

The milestone after deployment: what happens to a buyer when something goes wrong mid-purchase.

First, measured rather than guessed. `researchBrief` now records per-theme stage timings (`StageTiming`
on `ResearchResult`), `ResearchService` logs them on every generation, and a real run of
`demo-research.ts` over three themes took **16 s**: filings 5.3 s (the provider caches across themes, so
only the first pays), model 10.4 s, 30 SEC requests, $0.0207. Against Vercel's 60 s ceiling that is
comfortable but not vast, and a buyer asking for three dense themes is the case to watch. The timing
line is in the production logs now, so this stays measured.

That reframed the risk. If the function dies mid-handler, settlement never runs and the buyer is not
charged, which is the safe direction. The dangerous window is narrower: the payment settles and the
response never reaches the buyer. They are charged, and the receipt id existed only in that response.

So a buyer can now prove the wallet that paid and get their links back:

- The receipt records the `payer` the facilitator reported (new column, added with
  `add column if not exists`, so the deployed database took it without a migration step).
- `POST /receipt/nonce` offers an EIP-712 payload; `POST /receipt/recover` takes the signature and
  returns every receipt that wallet paid for.
- The address alone proves nothing, which is the whole point: payers are public on Base, so anyone
  watching the seller could otherwise read other people's briefs. The nonce is single use and short
  lived, so a captured signature cannot be replayed either. Same shape as the owner's sign-in, and
  deliberately so.
- The owner cannot recover someone else's briefs. Control of the paying wallet is the only key.
- `apps/web/src/Recover.tsx` is the buyer's side of it: connect, sign, get the links. Checked at 375 px
  for overflow, and the control explains itself when no wallet is present.

Seven new tests cover it, including a signature from the wrong wallet, a replayed nonce, a nonce the
server never issued, an address with no purchases, and a receipt written before payers were recorded.

### Where the money is actually at risk, checked in the SDK

Read rather than assumed: `@x402/express` buffers `writeHead`, `write` and `end` until settlement
finishes, and `@x402/core` awaits each `afterSettle` hook. So the order on any host is: settle onchain,
run our hook (book revenue, issue the receipt, flush to Postgres), then release the buyer's response.
The brief is never delivered before the sale is durable, and a function killed mid-handler settles
nothing, so the buyer is not charged. That is the safe direction.

The hole that leaves: a hook that throws is logged by the SDK as a warning and the response goes out
anyway, so a failed database write would mean money received and nothing recorded. `persistSale` is now
a separate exported function that never throws. On failure it logs
`MONEY RECEIVED BUT NOT RECORDED` with the transaction, amount, brief, payer and receipt id, which is
everything needed to reconcile against Base by hand. It deliberately does not abort the settlement: the
money has already moved, so failing closed would tell the buyer their payment failed while they have
been charged, and they would not get the brief either.

Core 256, API 178.

### Deploys from git, fixed 22 Nov 2026

Every push to GitHub had been failing while deploys from the laptop succeeded, which is the worst shape
for this to be in: the deployment that works is the one nobody can reproduce. The cause was
`functions: { "api/index.mjs": ... }` in `vercel.json`. That glob is matched against the files in the
repository, and `api/index.mjs` is a bundle produced by the build, not something anyone commits. The
upload from a laptop carried it; a fresh clone did not, and the build stopped at `unused_function`
before `npm install` had even run.

Replaced with the Build Output API: `scripts/build-vercel.mjs` writes `.vercel/output` (routing,
static site, and the function with the catalogue inside it), and `vercel.json` is now one line naming
the build command. Both paths run the same script.

Checked by building a fresh copy of the tree with the generated files removed, exactly as a clone
would be, then running the built function the way the host does: it assembled on Postgres with 7
briefs and answered 200 and 402 on the right routes. The deployment from the CLI then did the same
thing in production.

## The agent says how far it is from investing, 22 Nov 2026

"Nothing to invest, and that is correct" is true and not enough: it does not tell an owner whether that
is one sale away or a hundred. `investmentGap` in `packages/core/src/surplus.ts` turns the same rules
settlement uses into the number, and both `POST /invest/sync` and `GET /invest/ledger` return it.

On the live deployment right now:

```
shortfall      0.127614   costs revenue has not covered yet
reserve gap    0.480000   the protected reserve, still short
surplus needed 0.100000   so the 50% invest share clears the 0.05 minimum trade
REVENUE NEEDED 0.707614 USDC
```

One $2 commissioned brief covers all of it at once, which is the cheapest route to seeing the whole
loop run. The desk now prints those lines instead of "sell more briefs, raise the price", and says
plainly that the figure is a floor rather than a forecast, because selling another brief also costs
something to produce. The surplus figure rounds up, since the invest share rounds down and asking for
exactly the quotient lands a unit short; there is a test for that.

Also on the buyer's side, both of which were first-use failures waiting to happen:

- The wallet is put on the right chain before anything is signed (`ensureChain`), and offered the chain
  if it has never seen it. Without it the first thing a buyer meets is a payment that fails for a
  reason they cannot read.
- An empty catalogue is a real state and now says so, rather than offering a button that would take
  payment for a brief that is not there.
- The storefront says you need USDC but no ETH, which is true here and surprising enough to be worth
  saying: the facilitator pays the gas.

Core 261, API 180.

## Treating it as a product, 22 Nov 2026

Siddhant's instruction: "I want everything to be product ready. Nothing should be just for a hackathon."
What that turned into, in risk order.

**A hole I had opened myself.** `POST /receipt/nonce` and `POST /auth/nonce` are unauthenticated and
write a row per call, so anyone could grow a table in the database for nothing. The four routes that
are neither paid for nor signed are now capped at 20 calls a minute per caller, counted in Postgres so
the ceiling is one ceiling however many instances are running (`src/throttle.ts`). A limiter that
cannot answer lets the request through and logs it: the limit exists to stop abuse, not to become a
dependency that can take the API down. Verified against the deployment: the twenty-first call in a
minute returns 429 with `retry-after`.

**Nothing ran the tests before a deploy.** `.github/workflows/ci.yml` now runs typecheck, the scripts
typecheck, the full suite against a real Postgres service container, and a complete build, on every
push and pull request.

**The suites lied when the database was unreachable.** A failed connection reported as "22 skipped",
which reads exactly like "none configured". The helper now fails with a sentence naming the host, and
the first test in the file is an explicit reachability assertion.

**Health answered without checking anything.** `GET /health` now pings storage and reconciles the books
on every call, and returns 503 when either fails. An empty catalogue is reported but is not a fault: a
new deployment has one until the first brief is written. That makes any HTTP uptime monitor into the
alerting story.

**Errors could leak.** A rejected promise from an async route used to reach Express's default handler,
which answers with an HTML stack trace naming paths and packages. There is now a handler that logs the
detail and returns one sentence.

**No headers.** CSP, `X-Frame-Options`, `nosniff`, `no-referrer` and `cross-origin-opener-policy`, both
from the function and from the platform for the files it serves directly. Checked in a browser: no
violations, fonts still load.

**Backups were the provider's problem.** `npm run db:export -w @surplus/api` writes the ledgers, the
mandate history and every receipt as the same JSONL the file backend reads, and a nightly GitHub
Actions workflow keeps it as an artifact for 90 days (needs `DATABASE_URL` in the repository secrets).
Proved by replaying an export through the file backend: 2 entries, 2 sales, 0.020000 USDC, and the
dedup index restored.

**The research spend cap could still be overshot across instances.** Reservations now live in Postgres
(`src/reservations.ts`), so a generation in flight is visible to every instance. Reserve first and then
check, rather than the other way round, because checking first leaves a gap between deciding there is
room and taking it. The first version made both concurrent requests stand down, which is correct about
the money and useless to anybody: `outstandingBefore` orders the queue by `(at, id)` so the first one
through fits and the later one backs off. A reservation an instance died holding is swept after ten
minutes, because a budget permanently consumed by a crash would be worse than the overspend it guards.

Core 261, API 194.

## Execution made crash-safe, 22 Nov 2026

Siddhant said eligibility for India looks fine to him. That is his call and it is recorded as his; it is
not verified here, and routing money from India into tokenized US equities touches FEMA and the LRS as
well as the RBI's treatment of crypto rails, so it stays flagged for a professional. `MAINNET_ENABLED`
stays off until he separately authorises live execution. What changed is that the code is no longer the
reason to wait.

The executor was the least production-ready thing in the project: it had never run, its spend cap lived
in a field (so on a host that runs several instances it was a cap each, on real money), and a crash
between broadcasting a swap and recording it would have left money moved with nothing remembering.

- `src/journal.ts` is the record of what the agent has tried to do onchain, written before it tries,
  shared through Postgres. The spend cap is counted from it, and anything not known to have failed
  counts, because a transaction whose outcome is unknown may well have spent the money.
- The order around the send is inverted. The transaction is **simulated**, then **signed** (which fixes
  its hash without putting it on the chain), then the hash and the raw bytes are **recorded**, and only
  then is it **broadcast**. A process that dies anywhere after signing can ask the chain what became of
  a transaction it knows it signed, and rebroadcast the same bytes rather than build a second one.
- A key is claimed once. A second call for the same order resumes it rather than sending again: filled
  returns what was filled, failed refuses and says to propose again, sent asks the chain.
- `recover()` runs at start-up, before anything is served, because every number in the books is wrong
  until the unresolved transactions have been resolved.
- A simulation that reverts costs nothing and releases the claim, so a refusal before signing does not
  eat the cap.

Ten tests cover the ordering with a fake chain that records what it was asked to do and can be told to
fail at a chosen step, because the failure this is built around is a crash between two calls, which a
real node will not reproduce on request. `buildSwap` is injectable for the same reason: a test about
what happens around a send should not depend on an aggregator's endpoint being up.

Core 261, API 204.

## Real execution is now reachable, 22 Nov 2026

The executor was crash-safe and, it turned out, dead code: nothing called `fill`. `execute` always
simulated, so turning mainnet on would have changed a label and nothing else. Worse, had it been wired
up naively it would have booked quantities from the quoted price rather than from what the swap
actually returned, which is the difference between a ledger and a guess.

- `Treasury.execute` takes an optional `realized` map, keyed by leg index. With it, quantities are what
  the chain returned and the entry carries the transaction hash and drops the SIMULATED label. Without
  it, nothing changes: the simulation is still a simulation and still says so.
- A leg missing from that map did not execute. It is not booked, and the proposal ends FAILED however
  many of its siblings succeeded, because a proposal that half happened is not a settled proposal. The
  money that did move is still booked, because it moved.
- `splitFill` and `attributeFills` in `swapplan.ts` put the quantities back the way the money came out.
  One swap can cover several themes and the trade cap can spread one leg over several swaps, so this
  replays the plan's own order. Every unit is accounted for: the rounding remainder goes to the largest
  contributor rather than being dropped, because tokens in the wallet and in no entry would make the
  books disagree with the chain.
- `InvestingEngine.sendSwaps` sends one swap per order, keyed `proposal:position` so a retry resumes
  rather than sends again, and stops at the first failure. With real money a failed swap is a reason to
  look, not a reason to try the next one.
- Nothing is sent when a gate blocked the trade. The checks exist to be read before the money moves.

Core 272, API 207. The mainnet path is still off at the flag; what changed is that it is now a path.

## Revenue cannot cross networks, 22 Nov 2026

Siddhant has testnet USDC on Base Sepolia and $20 of real USDC on Ethereum mainnet, and asked whether
they can be used for production testing. The answer turned up a defect worth more than the question.

Nothing stopped `syncRevenue` mirroring the testnet sales book into a mainnet investing book. The agent
would then have spent real money while its books said it had earned the surplus. It now refuses to
mirror a sale whose mode is not the investing book's, and reports them as `refusedSales` rather than
skipping them quietly. A mainnet trade today is funded by owner capital, which is what the opening
float is and what its entry says.

Checked on Base mainnet, read only, before advising anything: $1.00 and $0.25 quotes for NVDAc, MSFTc
and AAPLc all return, 1.5 to 2.2 percent above NAV and the same at both sizes, so the spread at this
scale is the premium over NAV rather than price impact. Liquidity 3 to 5 against a gate that needs 2.
Fifty cents proves the path as well as fifty dollars would.

The $20 is on the wrong chain: the stocks are on Base, so it would have to be bridged, and Ethereum gas
on a small amount is a meaningful fraction of it. `docs/DEPLOY.md` has the order to do it in.

## Preflight, and what it found, 22 Nov 2026

Siddhant researched the Indian position on tokenized stocks, concluded it is not illegal, and authorised
proceeding. That is his decision and it is recorded as his. Claude does not execute trades with real
money regardless of authorisation, so the division is: everything up to the button is built and
rehearsed here, and he presses it.

`npm run preflight -w @surplus/api -- --symbol=NVDAc --usdc=0.50` does everything a real swap does and
stops before the broadcast: trusted set, liquidity, live quote, the pre-trade gates, the wallet's USDC
and gas, the calldata, and the chain's own answer through `eth_call`. `SwapExecutor.preflight` builds
the same calldata through the same code as `fill`, so it reports what would happen rather than arguing
that it ought to work. Nothing is signed.

It earned itself on the first run. **The NAV deviation gate is inert whenever the underlying market is
closed**: it blocks only when NAV is fresh, and a Saturday run reported NAV 34 hours old with the check
skipped, while the quote sat 2.2 percent above NAV with nothing to stop it being 10. The one guard
against paying far too much is off exactly when the premium is widest. A first real swap belongs in US
market hours. That is now in `docs/DEPLOY.md`, and it is the kind of thing that would otherwise have
been discovered with money on the line.

A second thing the preflight refuses to do: check anything at all against the wrong chain. A test asked
for every check and got one, which was right and the code was wrong.

## The desk says what the button will do, 22 Nov 2026

`simulatedFills` was derived from `INVEST_MODE` alone, so the desk would have said "Live fills" on a
server with no execution key, which simulates. The difference between a rehearsal and spending money
should not be inferred from configuration.

`GET /invest/execution` now answers it directly: whether a real swap would be sent and why not when it
would not, the wallet the swaps would come from, the spend cap with what is already committed, and any
transaction signed whose outcome is unknown. `/invest/ledger` asks that same source rather than
recomputing it, because two places deciding this is two places to disagree.

On the desk it is a notice above the controls, quiet for a rehearsal and coral when real money will
move, and the button reads "Execute with real money" rather than "Execute". Unresolved transactions are
named there too, since those are the ones that need resolving against the chain before anything else
is believed.

Not seen in a browser yet: showing it needs an owner session, which needs Siddhant's wallet. The routes
are covered by tests and the page builds and typechecks.

Core 272, API 215.

## The books against the chain, 22 Nov 2026

`reconcileInternal` proves the books agree with themselves, which is not the same as being true. The
check that can catch a lie compares what the agent recorded receiving against what the wallet actually
holds, and it is only meaningful once real swaps exist.

`comparePositions` in core does the comparison on integers: units the journal recorded against units
the chain reports, no price or quote anywhere near it. `SwapExecutor.positions` feeds it from the
journal's filled rows, summing several fills of the same token and ignoring the ones that failed, and
`GET /invest/positions` serves it behind the owner gate.

Short is the serious direction and fails the check: the books claiming tokens the wallet does not hold
is either a fill booked without happening or tokens that left without an entry. Extra is reported and
is not a failure, because the agent is not the only thing allowed to put tokens in that wallet. With
simulated fills the route says there is nothing onchain to compare rather than claiming reconciled,
which would be worse than saying nothing.

Core 277, API 219.

## Structured logs, and a bug my own test name caught, 22 Nov 2026

Operational events are now one line of JSON with a stable `event` name, so alerting is on a thing
rather than on a phrase: `sale_not_recorded` and `execution_unresolved` are the two worth waking
someone for. Every line keeps a readable `message`, because logs are read by people more often than by
machines, and the position check is on the desk now beside the internal reconciliation line.

The redaction is where this got interesting. The first version masked anything shaped like 32 bytes of
hex, on the grounds that a private key looks like that. So does a transaction hash, and the whole
purpose of `sale_not_recorded` is to carry the transaction of a sale that settled and could not be
written down. The test asserting that hashes survive had been written to assert the opposite, which is
how the contradiction surfaced: a test whose name and body disagree is usually the body being wrong.

Redaction is now by context, never by shape: connection strings, bearer tokens, and anything labelled
as a key or secret, with the label allowed a prefix so `EXECUTION_PRIVATE_KEY=` is caught while
`tokenBalance:` is left alone. The rule for key material is that it is never logged in the first place.

Core 277, API 224.

## The frontend pass, 22 Nov 2026

Run with the `frontend-design` and `taste-skill` skills. A judgement first: taste-skill deals a fresh
identity from its own kit, and applying that wholesale would have thrown away the navy, cream and
coral direction Siddhant chose and approved. So its **checklist** was used against the real pages and
its copy linter against the rendered DOM, with the identity left alone. Its browser checkers could not
run at all: they need Chrome or Chromium, and neither is installed here.

Checked at 1440, 390 and 320 through the in-app browser, on the storefront, the receipt page and the
desk sign-in. What was already right: no horizontal overflow at any width, text contrast 8.3 to 1
against the navy, headings in order, one h1 a page, every field labelled, reduced motion respected.

What was wrong, and is fixed:

- **No skip link.** A keyboard had to walk the header on every page. There is one now, off screen
  until focused, and it uses `:focus` rather than `:focus-visible`, because nothing but a keyboard
  reaches it and a skip link that stays hidden when focused is worse than none at all.
- **Two controls under 44px on a phone** (the text links, at 33px). They have a minimum height on
  coarse pointers and narrow screens now.
- **The tab said "Surplus" on all three surfaces.** Per-surface titles, plus a description, theme
  colour, share tags and a favicon drawn from the mark the page already uses.
- **A visitor with no wallet met a wall of coral.** Most people arrive without one: that is a
  circumstance, not a failure. It reads as a quiet note now, and coral is kept for what actually went
  wrong. Same on the sign-in page.
- **The receipt error ran two sentences together**: the server's reason landed mid-sentence, so it
  read as a fragment. It is its own sentence now, and the page points at the recovery flow rather than
  at the transaction hash, which is no longer the only way back.
- **Purchase outcomes were shown but not announced.** The result of a payment, a recovery and a desk
  action now carry `role="status"` or `role="alert"`, since none of them move the page.

`copy-lint` on the rendered storefront: 0 FAIL, 0 WARN, two INFO notes (one "no X, no Y" negation, and
the sentence rhythm).

Not verified: the skip link appearing on focus, because the browser pane never holds document focus,
so `:focus` cannot match there. The rule is in the stylesheet and the selector is right.

Core 277, API 224.

## The README said the wrong thing, 22 Nov 2026

The repository's front door still described a library prototype with "no production executor or
user-facing application" and an `apps/` folder "reserved for future applications". All three are
false, and a public repository whose README is out of date is worse than one with no README: it tells
a visitor the project is less than it is, and it tells the author nothing.

Rewritten for a reader arriving cold: what it sells, what is real and what is simulated as a table
rather than a paragraph, why the simulated part is simulated (the two halves are on different
networks, not a shortage of effort), how a brief earns the right to exist, how the money works, how to
run it, and the limits stated plainly including the eligibility question nothing in the repository
answers.

## Reads retry, writes never, 22 Nov 2026

A serverless instance that is still finding its database answers 503 for a moment, and the page was
showing "could not reach the agent" to whoever happened to be the first visitor in an hour.

Reads now retry twice, at 250 ms and 750 ms, on a network failure or a 502, 503 or 504. Writes are
never retried, and the comment says why: a POST here can settle a payment, approve a trade or spend a
nonce, and repeating one is not a retry but a second attempt at moving money. If a write is
interrupted the person is told and decides.

The storefront and the receipt page were still calling `fetch` directly and so had neither the retry
nor the error handling; both go through the shared reader now. A 404 is an answer and is not retried.

Core 277, API 224.

### Still open on this

- A real purchase against the deployed endpoint has not been made.
  `X402_API_URL=https://surplus-eosin-seven.vercel.app npm run buy -w @surplus/api` would prove the loop
  end to end and write the first sale into Postgres from the host. That spends testnet USDC from
  Siddhant's buyer wallet, so it is his to run.
- The deployment is not connected to GitHub (`vercel link` could not reach the repository), so deploys
  are manual: `npm run build && npx vercel deploy --prod`.

## First real sale from the deployed endpoint, 22 Nov 2026

Siddhant ran the buyer against the live URL and it worked end to end on the host: challenge, payment,
settlement, brief handed over, sale booked in Postgres by the host itself.

Proof: payer `0x8Ab8b5d0b8806868B636B9251e2e1d2753356384`, transaction
`0x169a7aa815ce9b88fe44d6e3796711e5c7a2f5bd7de951cec0ae7201f8e36c45`, amount `10000` on
`eip155:84532`, booked as ledger entry 3 (`PAYMENT_RECEIVED`, `testnet`, cash.operating +10000,
revenue.research -10000) attributed to `brief-2026-11-21T19-57-41-888Z` and carrying the payer. The
two entries before it are the local sales of 20 Nov that `db:import` copied in, which is why they say
`briefId: unknown` and carry no payer. Entry 3 is the first one the deployment wrote.

So the loop that was listed as unproven is proven: a paid request against the serverless deployment
reaches Postgres and reconciles.

### The bug it surfaced in the buyer client

`buy.ts` then died with `ledger.entries is not iterable` and exited 1. `/ledger` became owner-gated
when it stopped being a demo endpoint (it is the operator's whole financial history), so the
anonymous read now answers 401 with `{"error": ...}`, and the script cast that body to the success
shape without checking.

The shape mismatch is the lesser half. The real fault is that **money had already moved** and the
brief was already in hand when the script exited non-zero. An operator reading that exit code
concludes the purchase failed and runs it again, paying twice. Nothing after the brief arrives may
fail the run.

`showLedger(url, transaction)` now:

- never throws, and reports instead of failing, so the exit code reflects the purchase and nothing else
- sends `OWNER_TOKEN` when the person running it has one, and when they do not says the books are
  closed and points at the settlement transaction, which is public on Base and is a buyer's real proof
- checks the response status and the shape of the body before reading it, rather than casting
- reports the status of **its own** sale by matching the settlement transaction, instead of printing
  every sale in the book. Counting someone else's purchase as proof of this one is how a broken
  booking would have gone unnoticed

Verified by hand against the live endpoint: anonymous `GET /ledger` answers 401, and with the owner
token it returns the three entries above. The repaired script is typechecked but has not been rerun,
because a rerun spends another cent of Siddhant's testnet USDC and that is his to spend.

## What the first live sale exposed: the reserve target, 22 Nov 2026

The loop works, and that makes the next obstacle visible. It is arithmetic, not a bug.

Live mandate v2: `reserveTargetUsdc` 500000 ($0.50), `investShareBps` 5000, `minTradeUsdc` 50000
($0.05), `maxTradeUsdc` 1000000. Price is $0.01 a brief. `investmentGap` run against the live state
(revenue 30000, reserve balance 0) says: reserve gap $0.50, surplus needed $0.10, revenue needed
$0.60, so about 60 more sales at a cent before a single smallest-allowed trade can be placed. About
57 if the three cents already in cash.operating are counted, which `investmentGap` does not do because
they have not been swept into the reserve yet.

This is the consequence the price decision of 21 Nov predicted and it is now measured rather than
predicted.

The way out is Siddhant's to choose, because the reserve target is a term of his mandate and the agent
never changes user constraints:

1. Lower `reserveTargetUsdc` for the demo, through `POST /mandate`, which creates version 3 and
   invalidates any outstanding approval. A reserve of $0.02 with the same invest share puts the first
   trade about 12 sales away.
2. Accumulate sales. Honest, and at a cent each it means roughly 60 purchases.

Raising the price back to $3.00 is not on the table: it would make the demo work by making the shop
unusable to anyone without meaningful test USDC, and the 21 Nov note already ruled it out.

Note also that no cost is booked on the live host yet. `costUsdcMinor` for the catalogue brief is
21201 ($0.021201), so at a cent a sale a brief needs three sales just to pay for itself. That is a
true fact about the economics at this price, not a fault.

## The owner desk could not be signed into from a wallet, 22 Nov 2026

Siddhant imported `OWNER_PRIVATE_KEY` into his wallet, tried to sign in to the desk, and got "not a
valid owner signature". The owner flow had only ever been exercised through viem, never through an
injected browser wallet, and two faults were waiting there.

What was ruled out first: the deployment's `OWNER_ADDRESS` is `0x322472B62a297249234B258a48Df86ce8D620D48`,
which is exactly the address `OWNER_PRIVATE_KEY` controls, and signing the live `/auth/nonce` payload
with that key returns 200. Server, config and key all agree, so the fault was between the wallet and
the payload.

**1. The typed data never declared its own domain type.** `loginPayload` and `APPROVAL_TYPES` carried
only `Login` and `Approval`. viem infers `EIP712Domain` from the domain's fields, so every test and
every script passed. `eth_signTypedData_v4` expects it to be declared, and a wallet left to guess it
can guess differently, which surfaces as a signature the server rejects with nothing to point at.

Fixed with `EIP712_DOMAIN_TYPE` in `packages/core/src/eip712.ts`, added to the two payloads that cross
the wire to a wallet: `approvalTypedDataJson` and the `/auth/nonce` response. The server's own
verification still lets viem infer it, so the fix is additive.

Declaring it inside `APPROVAL_TYPES` and `LOGIN_TYPES` was tried first and reverted: viem then infers
the domain type from the declaration, and `chainId` as `uint256` makes it demand a `bigint`, which
would have pushed a type change through config, the engine and the tests for no behavioural gain.

Four tests pin the equivalence, because a drift between the wallet payload and the verified payload
would look exactly like a wallet signing the wrong thing: the declared fields match the domain's own
fields in order, the hash is identical with and without the declaration, and a signature made over the
wallet payload verifies against the payload the server builds.

**2. A mismatched account produced a true but useless message.** The desk is told which address it will
accept (`message.address`) and signed with whatever the wallet offered without comparing the two. A
wallet sitting on the wrong account therefore spent a prompt to earn "not a valid owner signature",
which names neither the address it wanted nor the one it got. `SignIn.tsx` now compares before signing
and names both. `Desk.tsx` does the same before an approval, since a wallet can switch accounts after
sign-in; this also gives its unused `currentAccount` import a job.

Also removed there: `Number(p.toSign.message.issuedAt) * 0` in the approval deadline, which contributed
nothing except a way for the deadline to become `NaN`.

Deployed and verified: `/auth/nonce` now answers with `types: [EIP712Domain, Login]`, and a signature
over it still verifies 200. Core 281, API 224.

Still unproven: whether a real browser wallet now signs it. That needs Siddhant's wallet, and if it
still refuses, the next thing to read is the wallet's own error rather than the server's.

## Buying from the page never reached the wallet, 22 Nov 2026

Clicking buy on the storefront, with MetaMask connected, failed with "Failed to create payment payload:
Do not know how to serialize a BigInt".

`wallet.ts` serialised the typed data with a bare `JSON.stringify`, which throws on a bigint. A bigint
is the correct representation of a uint256, and the payment scheme uses it: an EIP-3009 authorisation
carries `value`, `validAfter` and `validBefore` that way. So the wallet was never reached at all, and
the buyer was shown a sentence that is true about our code and useless about their purchase.

Fixed with `toSignableJson`, which converts bigints to decimal strings on the way out. That is what
`eth_signTypedData_v4` expects for a uint256 and exactly how the server already sends its own amounts,
so it converts rather than reinterprets, and no value passes through a float. It sits on the one
function every signature in the page goes through, so the login, the approval and the payment all get
it.

The chain guard was already right here: `Store.tsx` reads the CAIP network out of the 402 and calls
`ensureChain` before paying.

### The real lesson: `apps/web` had no tests

Three signing bugs in a row (the missing `EIP712Domain`, the unchecked account, this) all lived in
browser code that nothing ran. Every one of them was reachable by a pure unit test.

`apps/web` now has a test script and `apps/web/test/wallet.test.ts`, which needed no new configuration:
vitest is already a root dependency and these are pure functions. `npm test` runs core, then the API,
then the web, and `npm run test:web` runs it alone. Five tests to start: the EIP-3009 shape serialises,
a value too large for a double is not rounded, non-bigints are untouched, and `chainIdFromCaip` refuses
anything it does not recognise rather than guessing a chain.

Core 281, API 224, web 5.

## The storefront purchase works, and the 502 was a region, 22 Nov 2026

After the BigInt fix a browser purchase settled for real: transaction
`0xcd716e115484b9b924c0166f246d8aca25ccb26e8177d41fe662817db35ebd93`, status success, block 62145421,
submitted by the facilitator `0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf`, booked as ledger entry 4 and
attributed to `brief-2026-11-21T19-57-41-888Z`. So paying from the page, with MetaMask, against the
deployment, works end to end. The 502 Siddhant saw came from a later attempt.

**A reporting mistake of mine, recorded because it is the kind that matters.** Asked whether he had been
charged, I compared the buyer and seller USDC balances against figures I had read earlier in the same
session and said nothing had moved. Both readings were taken after the settlement, so they agreed with
each other and told me nothing. The books were the authority available the whole time and they said
four sales. Balances are a differential measurement and are worthless without a baseline from before
the event.

The receipt recovery path then did its job: signing the recovery payload with the payer key returned both
purchases with their secret links, which is the remedy for a buyer whose response never arrived. First
time it has been exercised against production.

### Why the facilitator timed out, and a wrong diagnosis on the way

First answer, now withdrawn: the host's log lines carry a `region`, the failing one said `bom1`, and I
wrote that up as a Mumbai instance unable to reach `x402.org`. It was wrong, and it was wrong in the
same way as the balance mistake above: a field was read as if its meaning were known.

What the evidence actually supports, in the order it was established:

1. The Vercel project's `serverlessFunctionRegion` was **already** `iad1`, before anything was changed.
   So whatever region the function ran in, it was not configured to follow the buyer.
2. `/health` now reports `process.env.VERCEL_REGION`, which the host sets inside the running function,
   and it says `iad1` on every read. A log field whose meaning I guessed at loses to the runtime's own
   statement about where it is.
3. `/health` also measures the facilitator now. From production it answers in **66 to 138 ms**, five
   reads out of five. The call that hung for 90 seconds answers in a tenth of a second from the same
   place.

So the hang was transient, not geographic: either `x402.org` had a bad moment, or that cold instance's
first outbound call stalled. Nothing found so far explains which, and nothing should be written up as
if it did. The `regions: ["iad1"]` added to `vercel.json` and the function config is harmless and
matches the project setting, but it fixed nothing and must not be described as the fix.

What genuinely changed, and why each of these stands on its own:

- `FACILITATOR_TIMEOUT_MS`, default 15000, passed to `HTTPFacilitatorClient`. Its own default is 90
  seconds, the wrong order of magnitude for someone standing in front of a page when the facilitator
  normally answers in under 150 ms. A recurrence now costs a buyer 15 seconds, not a minute and a half.
- `describePaymentFailure` no longer ends a timeout with "try again". A timeout is the one failure where
  the money may already have moved, so the buyer is sent to "Lost your link?" with the same wallet
  before buying again. Tests assert the message never says "try again" or "nothing was charged" on a
  timeout, because both would be guesses about someone's money.
- `/health` reports `region`, and `facilitator` with its latency. This incident cost a lost purchase and
  a dig through host logs to reach a diagnosis that was then wrong; one request answers it now.
  Reported, never fatal: an unreachable facilitator stops sales but breaks neither storage nor the
  books, and flapping health on someone else's outage would ruin it for the two faults it exists to
  catch. The check is injected like `storageCheck`, so no test reaches the network to answer it.

Core 281, API 226, web 8.

## invalid_exact_evm_signature, and what it is not, 22 Nov 2026

A browser purchase was refused with `invalid_exact_evm_signature`. No sale was booked and the buyer's
balance was unchanged, measured against a baseline taken at the time rather than one remembered from
earlier in the session.

Our own serialisation was the obvious suspect, since the BigInt fix had just landed on that path, and it
was ruled out properly rather than by reading the code: `scheme.createPaymentPayload` was driven locally
with a signer that reproduces the browser exactly, serialising through `toSignableJson` and signing the
JSON that comes back out. The resulting signature recovers to the authorisation's own `from`. The
round trip through decimal strings is faithful.

So the rejection means the account that signed is not the account the payment pays from, which the
facilitator cannot distinguish from a serialisation bug and reports with one opaque string either way.

Everything needed to tell those apart is in the page already, so `checkPaymentSignature` now recovers
the signer and compares it to `authorization.from` **before the payment is sent**, and refuses a doomed
one rather than spending a round trip to be told no. It names both accounts. Two real causes it catches:
a wallet with several accounts signing with a different one than it offered, which is easy to arrange by
importing a key, and a second wallet extension answering a request the first was asked.

It also refuses an authorisation whose `validBefore` has already passed, because a prompt left sitting
produces a signature the facilitator will refuse and "this expired while it waited to be approved" is
something a person can act on.

`describePaymentFailure` translates the facilitator's string too, for the case where the signature is
somehow valid locally and refused there anyway. Every one of these messages says nothing was charged
only where that is known from the failure itself: a rejected signature never moved money, unlike a
timeout.

Still unknown, honestly: which of those causes was Siddhant's. The page will now say, in the message
itself, rather than needing another round of this.

Core 281, API 226, web 13.

## Desktop-first frontend redesign, 22 Nov 2026

All three surfaces rebuilt against the brief in `docs/DESIGN.md`, which carries the tokens, the layout
principles, the wireframes and the critique. The identity is unchanged: navy, cream, coral, Archivo and
Newsreader. Two semantic colours were added because the desk has to say "this is a rehearsal" and "the
books agree" without borrowing coral, which is reserved for the action and for alarm: `--sim #7FA6C9`
and `--good #5FB49C`.

The one editorial decision worth recording: **Newsreader now carries claim text and quoted filing prose
on every surface, and Archivo carries every number, label and control.** A brief is a document and the
desk is an instrument, and the type should not pretend those are the same kind of thing.

### What changed on each surface

**Storefront.** Both purchases now sit in the hero as two cards of equal width, type scale and button.
They are deliberately not symmetrical in content: the left shows the real counts of a brief that exists
(themes, verified facts, filings read), the right shows the rules and the wait for research that does
not exist yet. The second leads to the theme form rather than straight to a payment, so its button is
the ghost variant and scrolls to the form and focuses it. Loading, no-brief, no-wallet, paying, paid and
failed each have their own line in one `.states` region, so two outcomes can never be on screen at once.
No claim or quote appears in the public catalogue.

**Receipt.** Rebuilt as a document with a filings rail. It now renders **every claim a fit cites and
every quote under each**, where it previously rendered `claimIds[0]` and `quotes[0]` with no sign that
there was more. Source citations link to the filing itself with `target="_blank"` and
`rel="noopener noreferrer"`; the API had always sent `url`, the frontend type simply omitted it.

**Desk.** Organised around the five steps the agent actually enforces: sync, propose, review, sign,
execute. `steps.ts` holds that as a pure function with a `blocked` state kept separate from `later`,
because "you cannot propose yet" and "you will propose next" look identical in a progress bar and mean
completely different things. Evidence uses the same component as the receipt. Ledger, reconciliation,
positions and the mandate are all still reachable without crowding the step. Simulated against real is
stated before the execute button and again in the result, from `GET /invest/execution`, never inferred
from configuration.

**Mandate controls.** A new section with every term grouped by meaning, a review of exactly what changed
before saving, the new version and the reapproval warning after, and the version history with its chain
verification state. Only changed terms are sent, so the server's list of what changed stays true and a
term the owner never touched is never reset. Percent converts to basis points on the digits of the
string rather than through a float: `0.07%` through a float is 6.999999999999999 bps.

### API and storage changes, both additive

- `receipts` gained a nullable `network` column, created the same way `payer` was, with
  `alter table ... add column if not exists`. New receipts store the settlement network so the page can
  link to the right explorer. **Old receipts keep `network` absent and the API answers `null`**, and the
  page then shows the hash without a link and says why. It is never filled in from the running config:
  this server's chain today is not evidence of where an old sale settled. Tests cover both.
- `mandateView` now reports `investOnlyWhenAhead` when the mandate carries it. The write path already
  accepted it; only the read path was blind, so the desk could not show a constraint the owner holds.
- `GET /catalogue` was missing from the Vite dev proxy, so the storefront could not load its own
  catalogue in development. Fixed, and verified live in the browser.

### Verified, and not

Reviewed in a real browser at 1440 and 1280 and again at 375: the storefront, the signed-out desk, the
receipt with a real brief, and the receipt's not-found state. Two layout faults were found and fixed
that way, both invisible in the source: a full-height surface was centring its navigation bar along with
its message, and the first fix for it stretched the wrong grid row on a page with four children.

**Not visually reviewed: the desk once signed in, and the mandate editor.** Both need an owner session,
which needs an EIP-712 wallet signature, and this task said not to perform one. Their logic is covered
by unit tests and typecheck, but no screenshot of them exists and none should be claimed.

The multi-claim evidence path is covered by unit tests rather than by the screenshots: every fit in the
current catalogue brief happens to cite exactly one claim.

Core 281, API 229, web 40.

## The frontend was rebuilt: soot and lime, Tailwind and motion, 22 Nov 2026

Siddhant rejected the navy and coral design as generic, and he was right: dark ground, glass panels and
one warm accent is a look rather than a decision, and it was the same look on a page you read and a
page you operate. Four rounds of mockups narrowed it to a direction and it is now in the codebase.

The direction, "soot and lime": near-black `#0f0f0f`, Archivo for everything a person reads, DM Mono for
every figure, hash and address, and a pale lime `#DAFA9C` rationed to the one action meant to be pressed
and the marks that say a thing was verified. Amber is real money, red is something dropped or failed.
The earlier rounds and the reasoning are in the published mockups; the tokens are the real record and
they live in `apps/web/src/theme.css`.

### Stack changes

- **Tailwind v4** through `@tailwindcss/vite`, configured in CSS rather than a config file. Every colour,
  face and easing is an `@theme` token, so changing the look is editing one file. Both Tailwind packages
  are devDependencies: they are build-time tools, and leaving them in `dependencies` put `vite` and
  `esbuild` into the production tree, where `npm audit --omit=dev` immediately reported two advisories
  that have nothing to do with what ships.
- **`motion`** (the package formerly called framer-motion) for the animation. It is reached only through
  `src/motion.tsx`, which wraps the tree in `LazyMotion` with `domAnimation` and re-exports `m` as
  `motion`. The full `motion` component cost 58 kB gzipped on a storefront whose job is to load fast for
  someone who has not paid yet; this is about 41 kB and `strict` throws if a plain `motion.*` import
  sneaks back in. Still worth another look later.
- **Routing**, about thirty lines in `App.tsx` over `history.pushState` and `useSyncExternalStore`. Five
  routes that do not nest did not need a router dependency. Links stay links, so middle-click and
  open-in-new-tab still behave; only in-app navigation is intercepted.
- `src/styles.css` is gone. `src/Spike.tsx` is an unrouted scratch page that referenced it and is now
  unstyled; nothing imports it.

### Surfaces

`/` storefront, `/r/:id` brief, and the desk split into three real routes: `/desk` decision,
`/desk/mandate`, `/desk/book`. The desk was three jobs in one scroll before.

Nine motion moments, each tied to something the product does rather than added for movement: the hero
arrives as one orchestrated entrance, the underline draws under "can prove", the proof chain lights
claim to quote to filing to EDGAR in sequence, figures count once, evidence rows open on a grid-rows
transition, the step rail marks the current step, and the hero lights faintly where a pointer is.
Everything is off under `prefers-reduced-motion` and each moment ends in its finished state.

### Verified

Typecheck clean, core 281, API 229, web 40. Reviewed in a browser at 1440 and at 375: no horizontal
overflow at either, sections measured rather than eyeballed (hero 606, stats 106, how 431, commission
592, recover 417, footer 120 at 1440).

Two things caught in review that the source would not have shown: the first screenshots looked broken
because they were taken mid-entrance, before the staggered hero had landed, and `index.html` was still
loading Newsreader and declaring a navy `theme-color` and a coral favicon from the old direction.

**Not visually reviewed: the desk once signed in, and the mandate editor**, both of which need an owner
session and therefore a wallet signature. Their logic is covered by tests and typecheck.

## One page became a site, 23 Nov 2026

Siddhant's note: the landing page and the app were the same scrolling document, the nav was a table of
contents pointing at sections of the page you were already on, and there was no page for the themes or
the filings the agent has read. He asked for the pattern most products use, with tilt-rust.vercel.app
as the reference: information on the landing page, an "Open app" button that goes somewhere else, and a
simple nav of real places. He also asked for Base's wallet connect SDK.

### The pages now

| Path | What it is | Can it move money |
|---|---|---|
| `/` | Landing. Nothing on it wakes a wallet or loads the payment stack. | No |
| `/themes` | Every theme researched, the companies under each, how often one came back empty. | No |
| `/filings` | Every SEC document read, newest first, linking out to EDGAR. | No |
| `/app` | The counter: connect, buy the latest brief, commission your own themes. | Yes |
| `/app/portfolio` | One wallet's briefs, spend and balance, opened by a signature. | No |
| `/r/<id>` | A bought brief. | No |
| `/desk`, `/desk/mandate`, `/desk/book` | The owner's desk. | Yes, each trade signed on its own |

`/library` and `/store` are replaced in history rather than left to 404, so a shared link still lands
somewhere, and Back goes where the visitor came from rather than to the path that would move them
again. Anything else gets a not-found page that offers the three live ways out.

### Two API routes had to move

The new endpoints were at `GET /themes` and `GET /filings`, which is exactly where the web app now has
pages. Express would have matched the API route first and answered a person's navigation with JSON.
They are now `GET /catalogue/themes` and `GET /catalogue/filings`, and `catalogue` was added to the
single-page fallback's exclusion list in `app.ts`: without it, a catalogue path the server did not
register would answer a machine with a web page instead of a 404.

Neither endpoint leaks anything a buyer paid for. A theme id is the name of a question and a filing is
a public SEC document with a public URL; the claims and quotes that connect the two are the product. A
test asserts that neither response contains a claim, a quote, or a stored excerpt.

### Wallets: wagmi, and one connect button

Two goes at this, and the second one is what shipped.

The first used `@base-org/account` behind a hand-rolled registry: a module-level provider variable,
two SDKs, and every surface asking "is something connected?" in its own way. Siddhant called the
experience thrash and he was right about the cause. Nothing told the page when an account changed, a
reload forgot the wallet entirely, and it ended up presenting two buttons side by side, Coinbase and
browser wallet, which asks a visitor to know the difference before they have any reason to care.

Now: **wagmi 3**, one store every component reads, reconnecting the last wallet on mount, with
account and chain changes arriving as state rather than as events nobody subscribed to. One
`ConnectButton` (`src/Connect.tsx`) on the app, the portfolio and the owner desk. Someone with
nothing installed has exactly one option and goes straight to it. Someone with an extension gets a
small native `<dialog>` listing what they actually have, named and iconed as the browser announced
them over EIP-6963, so the focus trap, Escape and the backdrop are the browser's rather than three
more things to get wrong.

Two faces onto the same store, because most of this app is not a component:

- `src/wallet.ts`, imperative, for the x402 payment stack, sign-in and receipt recovery, all of which
  want `signTypedData(address, payload)` they can call. Connecting is deliberately not in it.
- `src/Connect.tsx`, hooks, for the pages that show who is connected.

### Why not RainbowKit or OnchainKit

Both were tried, because a ready-made connect modal is the obvious answer and one of them is Base's
own kit. Both need **wagmi 2**, and wagmi 2's `@wagmi/connectors` hard-depends on WalletConnect,
which depends on `@reown/appkit`. Measured, with OnchainKit's modal wired up and working:

| | wagmi 3, our button | wagmi 2 + OnchainKit |
|---|---|---|
| `npm audit --omit=dev` | 0 | 35 (22 high, 13 moderate) |
| Total JS, gzipped | 326 kB | 1,100 kB |
| Wallet chunk, gzipped | 68 kB | 476 kB |
| WalletConnect in the bundle | no | yes |

The modal statically imports every wallet it supports, which is where the 557 kB MetaMask SDK chunk
came from, and `supportedWallets` cannot remove the defaults. Half a megabyte and 22 high advisories
to render a button is the overcomplicated outcome, not the simple one. RainbowKit 2.2.11 has no
wagmi 3 release and there is no newer tag.

**Stay on wagmi 3** until one of those libraries supports it. Three things also fell out of the move
to wagmi and are worth keeping:

- `toSignableJson` is gone. It existed because `JSON.stringify` throws on the bigints in an EIP-3009
  authorisation; viem encodes a uint256 from a bigint directly, so the problem does not arise. Its
  tests were replaced with tests for `signableTypedData`, which does the one transformation still
  needed: dropping the declared `EIP712Domain` from `types` so viem derives it from the domain
  instead. A declared one would override what viem derived, and a disagreement there is a signature
  the server rejects with nothing to point at.
- `ensureChain` no longer carries its own table of RPC urls and explorers. wagmi offers an unknown
  chain to the wallet from the chain definitions in the config.
- The balance read goes through the config's public transport rather than the wallet's provider.

**The owner desk uses the same button but accepts one fixed address and verifies EOA signatures**, so
a Coinbase Smart Wallet address would be rejected after signing rather than refused up front. Worth
revisiting only alongside ERC-1271 verification.

Cost, and what was done about it: wagmi, viem and react-query are about 68 kB gzipped, and three of
this site's pages are a person reading about an agent. They load with `Wallets.tsx`, mounted only by
`WalletPages.tsx` (`/app`, `/app/portfolio`) and `Owner.tsx` (`/desk`). The main chunk is 120.9 kB
gzipped, below the 125.8 it was before wagmi and the 127 it was before any of this.

### Other changes worth knowing

- The desk is lazily loaded (`Owner.tsx`). One person will ever open it, and the landing page should
  not ship the controls for someone else's treasury. The main chunk went from 135.9 kB gzipped with the
  new pages inlined to 125.8 kB, below where it was before them.
- `Recover.tsx` is gone. It was a second implementation of what the portfolio page does, with its own
  copy of the signature flow; `/app` now points at the portfolio instead.
- Shared chrome moved into `Chrome.tsx`: `SiteNav`, `SiteHeader`, `OpenApp`, `Figures`, `Note`, `Spine`.
  `Band` in `Sections.tsx` now uses `Spine` rather than its own copy of it.
- The nav collapses to one scrolling row on a phone rather than a menu button. Four links do not need a
  drawer, and a drawer is another state to get wrong.
- The themes page counts gaps as occurrences, not as themes that have never found anything. The same
  question can find something in one brief and nothing in the next: longevity-biotech is covered once
  and empty in six of seven briefs, and a count of "themes that never found anything" would have
  reported zero gaps on a catalogue full of them.
- The filings page shows citations rather than publishers. Every publisher is SEC EDGAR, and a figure
  that is always 1 is furniture.
- A filing's URL is checked to be http or https before it is linked. Source documents are untrusted
  data everywhere else in this project and a URL is no exception.

### Verified

Typecheck clean across core, API, scripts and web. Core 281, API 234 (25 Postgres tests included), web
48: seven new ones cover the router, including trailing slashes, a receipt id that is not one, and the
retired paths, and four cover `signableTypedData`. Every page was loaded against the running API and read back: themes shows 3 themes,
9 companies and 6 empty runs across 7 briefs; filings shows 15 real documents with their EDGAR links.

**Not visually reviewed: the desk once signed in, and the mandate editor**, unchanged from before and
still needing an owner wallet signature. The browser pane also hid itself partway through the review,
so the later checks are DOM and text rather than screenshots.

## Pricing, and why the agent has never invested, 23 Nov 2026

Agreed with Siddhant on 23 Nov. No code written yet; this is the plan the next milestone implements.

### The finding

The investing book holds four entry types: one opening balance, three payments, seven cost accruals,
one reserve top-up. **No fills, simulated or real.** The allocator, approval state machine, swap
planner, journal, drift detection and position reconciliation have never run end to end against the
agent's own revenue.

It is an economics problem, not a bug:

```
cost per brief   $0.021087   (gemini-3.1-flash-lite, ~70.6k in / 2.3k out over 3 calls)
sale price       $0.010000
break-even       2.1 sales per brief

7 briefs made, 3 sold.  Revenue $0.030000, costs $0.147614, behind by $0.117614.
```

Every brief produced puts the agent further behind, because one costs roughly twice what it sells
for. `surplus.investable` is therefore always zero and `propose` always answers "nothing investable".

### Three corrections to the record

- **`investOnlyWhenAhead` is not what blocks it.** The stored mandate is version 2 and does not carry
  the term at all; `investing.ts` tests `=== true`, so the gate is off. The `true` in `app.ts:70` is
  a first-run default that a stored mandate overrides and never re-applies.
- **The live reserve target is `$0.50`, not `$2.00`.** Same reason: `$2.00` is the first-run default
  in `app.ts`. The reserve currently holds `$0.02`, so the gap is `$0.48`.
- **`surplus.investable` is credited in exactly one place**, `settleBrief` sweeping `revenue - costs`
  (`surplus.ts:167`). Opening float lands in `cash.operating` against `equity.opening` and never
  becomes investable. So the line in CLAUDE.md saying "whatever a mainnet book invests is owner
  capital (`OPENING_FLOAT_USDC`)" describes an intent the money rules do not implement: a mainnet
  book, which cannot receive testnet revenue, has nothing to invest at all. Fix the doc or implement
  an explicit owner-capital entry, but do not leave them disagreeing.

### What the price has to clear

Revenue must beat costs, then fill the `$0.48` reserve gap, then leave `$0.10` of surplus so the 50%
share clears the `$0.05` minimum trade. **Cumulative revenue must beat cumulative costs by `$0.58`
before one minimum trade is possible.** On the existing 7 briefs that is about `$0.73` of sales: 73
sales at `$0.01`, or three at `$0.25`.

### Decisions

1. **Catalogue brief goes to `$0.25`.** The rule, which matters more than the number: price at
   roughly **4x the generation cost of the model actually shipped**. At 1x the agent only breaks even
   if every brief sells; at 4x a single sale pays for the brief outright, so producing research stops
   being self-harm, and the next three sales fund the reserve and the first trade. Flash is estimated
   at about `$0.06` per brief, which puts 4x at `$0.24`. **Measure the real Flash cost on the first
   run**: the Gemini 3.8 Flash pricing in this document comes from secondary sources only.
   If the demo ships on Sonnet (~`$0.16`), the same rule gives about `$0.65`.
2. **`/research` stays at `$2.00`.** Its cost is marginal rather than amortized, the margin is
   already large, and `RESEARCH_MAX_USD` enforcing "a generated brief never costs more than the buyer
   paid" stays untouched.
3. **Express the reserve as runway**, not a fixed figure: enough to generate roughly 20 more briefs,
   which at today's cost is about `$0.42`. Same order as the current `$0.50`, but it is a policy that
   moves correctly when the model changes, and it is explicable to a reader.
4. This **deliberately reverses** the note at line 81 of this document, "do not quietly raise the
   price back". The `$0.01` was right when the only goal was proving a purchase with minimal test
   USDC. It is wrong now that the goal is the agent funding itself, because at `$0.01` the agent is
   arithmetically incapable of ever investing. Raised loudly, with the reason recorded.

### Agreed order of work after the pricing change

1. **Close the loop once, end to end**, with real revenue and simulated fills: sale, settle, sweep,
   propose, owner signs, execute, reconcile. The proof is the cycle completing, not the fill being
   real. This has never happened and it is the single biggest missing demonstration.
2. **Build the sell path.** `quoteBuy` hardwires USDC as `tokenIn`, so the agent can accumulate and
   cannot exit. A mandate with no exit rule cannot express take-profit, rebalance or a drawdown
   limit. Largest genuine capability gap in the system.
3. **Skin in the game.** Join a position back to the brief and theme that justified it and show it on
   the brief, so the research half and the treasury half are one product rather than two sharing a
   wallet. Needs step 1 to have happened before there is anything to show.
4. **Run the facilitator in-process.** `@x402/core/facilitator` exports `x402Facilitator`, and
   `@x402/evm/exact/facilitator` exports the facilitator-side `ExactEvmScheme` (distinct from the
   `@x402/evm/exact/server` one already wired in `server.ts`). `x402ResourceServer` takes a
   `FacilitatorClient` interface of `verify`, `settle` and `getSupported`, documented as implementable
   for "HTTP-based or local facilitators", so a local adapter replaces `HTTPFacilitatorClient` with no
   network hop. It needs a wallet holding ETH to pay settlement gas, and it should use a key separate
   from the trading key. This removes the facilitator timeout and unreachable-region failure modes,
   and it is the only route to mainnet revenue without a paid provider. Not a prerequisite for
   anything above it.
5. **Mainnet last**, behind `MAINNET_ENABLED`, a spend cap and a throwaway wallet. Siddhant instructed
   on 23 Nov to set the eligibility question aside and focus on the product; it is recorded here
   because it still gates any real purchase of tokenized stocks and needs qualified advice, not an
   opinion from this project.

### Also agreed

`docs/PDF-PROMPT.md` holds a brief for Claude Design to produce an explainer PDF, in the site's own
soot-and-lime system. On Siddhant's instruction it describes **Surplus complete**, not Surplus as it
stands, so it is written in the present tense about the finished design: the full money loop
including the exit, skin in the game, and the agent funding its own investing. The honesty mechanism
is a single framing line on the cover saying the document describes the complete design, plus a page
of permanent boundaries (no custody, no trading on a buyer's behalf, no model touching money). It
covers why anyone buys verified public data and who already sells research for a living. It carries
no build-status page and no roadmap, so **it will describe behaviour that does not exist yet**; keep
that in mind before sending it anywhere that reads it as a statement of fact.

## Next milestones, in order

1. Web UI over the simulated loop (brief with quotes shown under each claim, proposal, approval, ledger). Simulation labels must be obvious.
2. Owner EIP-712 signature on approvals, persistence, deployment, onchain reconciliation.
3. Demo rehearsal, video, X post tagging @buildonbase, submission form. Re-check the Quest page rules on 24 Nov and 2 Dec, and re-read base.org/stocks before any mainnet use.
4. Real swaps only after Siddhant's explicit authorization, eligibility advice, a spend cap, the mainnet flag, and a throwaway wallet. Execute one swap per `SwapOrder` from `swapPlan`, not one per leg: gas is 2 to 4 percent of a $0.10 leg.

## Core modules (packages/core/src)

money, ledger, mandate, surplus, policy, allocator (water-filling; leaves unplaceable money uninvested with reasons gap, company_cap, max_trade, below_minimum, unassigned), tokens (Coinbase token API, paginated by next_page_token), research (brief types, `validateBrief`, `isFactSupported`, `toCandidates(fits, liquidity, floor = 3, minLiquidity = 0)`), approval (proposal state machine), registry, liquidity (DexScreener per-token endpoint), swapplan (`swapPlan` merges same-token legs into one swap each, capped at `maxTradeUsdc`), reconcile, treasury, quote (KyberSwap), gates, pipeline (research orchestration and verification; `quoteCheck` gives the per-quote verdict, `quoteInText` wraps it, `mentionsAny` is the theme-relevance rule), edgar (SEC client and doc provider), anthropic, gemini.

## Verified facts (with where they came from)

- Coinbase Tokenized Stocks API: `GET https://api.coinbase.com/v1/tokenized-stocks`, paginated with `next_page_token`; omitted fields mean defaults; `nav_price` is a reference value; multipliers are not always 1. It returned 87 tokens one day and 378 another; only the 10 on base.org/stocks are trusted.
- Native Base USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (Circle's site).
- All 10 trusted tokens have deep Aerodrome USDC pools (per-token DexScreener survey; the batch endpoint returns only one pool per token, which earlier made some look thin).
- KyberSwap aggregator: `https://aggregator-api.kyberswap.com/base/api/v1/routes`, router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` pinned, routes expire in about 30 s, timestamps in unix seconds.
- SEC EDGAR: max 10 requests per second, declared User-Agent with name and email, no API key (sec.gov/os/accessing-edgar-data). `company_tickers.json` keys `cik_str`, `ticker`, `title`; `filings.recent` has `accessionNumber`, `form`, `filingDate`, `reportDate`, `primaryDocument` (confirmed by `spike-edgar.mjs` on 21 Nov 2026). All 10 underlying tickers resolve, including SPCX (SpaceX, CIK 1181412).
- Anthropic Messages API: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type`. `claude-sonnet-5-5` is $2 / $10 per million input / output tokens (platform.claude.com models overview, read 21 Nov 2026).
- Gemini API: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`; thought parts carry `thought: true`; output price includes thinking tokens. `gemini-3.1-flash-lite` is $0.25 / $1.50 per million (ai.google.dev pricing, read 21 Nov 2026). Free tier content is used to improve Google products; paid tier is not.

## Assumptions and unverified items

- Siddhant believes he can access these tokens from India. Legal eligibility is not verified and needs qualified advice before any real purchase.
- The meaning of each `paused_features` flag is unknown, so any flag blocks trading.
- Whether KyberSwap's extraFee is truly zero is unverified.
- Gemini 3.8 Flash pricing ($0.75 / $3.75 until 31 Dec 2026, then $1.50 / $7.50) comes from secondary sources only; Google's pricing page did not list it on 21 Nov 2026.
- Google's generateContent API is labeled legacy in its quickstart (Interactions API recommended); still served.

## Known limits of the research checks

- A verbatim quote proves the text exists, not that it supports the claim. Numbers are checked in code; extra words (product names, causes) are discouraged only by the prompt. Always show the quote under each claim in any UI.
- Text injected into a filing and quoted verbatim would pass verification (a test documents this).
- Custom user themes have no keywords yet, so the relevance check does not apply to them.
- The 300-character cap discards accurate quotes. This is deliberate (short excerpts, and a fact's text is checked only against its quotes) but it means a fact whose only proof is one long sentence cannot survive. The prompt now steers around it and the drop message names it, so it is visible rather than silent.
- A `not_found` verdict can mean the model recited a different filing from memory rather than inventing text. AAPL did this in the 21 Nov run, quoting Apple advertising language absent from the retrieved document.

## Environment (.env, never committed)

`MODE`, `MAINNET_ENABLED`, `MAINNET_SPEND_CAP_USDC`, `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SEC_USER_AGENT`, `LLM_PROVIDER`, `RESEARCH_MODEL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PRICE_INPUT_PER_MTOK_USD`, `PRICE_OUTPUT_PER_MTOK_USD`, `RESEARCH_MAX_USD`. Prices are paid-tier rates even on a free tier so the ledger books a realistic cost.

## Lessons from earlier milestones

- Never run `npm audit fix --force` (it would jump vitest majors). Use `npm audit --omit=dev`.
- Scripts use top-level `async function main()`; tsx runs them as CommonJS-compatible.
- `scripts/tsconfig.json` sets `"types": ["node"]`; without it editors report `Cannot find name 'process'`.
- A KyberSwap or DexScreener survey that prints raw JSON is too long to paste; summarize in the script.