# Surplus handoff notes

Written 21 Nov 2026 when the project moved from a Claude chat to Claude Code. The chat also produced a 10-section build plan, saved as a Claude doc titled "Surplus: Build Plan for Base Stocks Maxxing Season"; Siddhant has the link.

## Where we stopped

1. The research pipeline works end to end against real SEC filings and Gemini (`gemini-3.1-flash-lite`). Latest real run: 3 model calls, about 70,600 input tokens, cost about $0.021 booked at paid-tier rates, zero validation issues.
2. `npm test` runs core (234 tests, 25 files) and the API (85 tests, 6 files).
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

Price decided 21 Nov 2026: `$0.01` by default, down from `$3.00`, so a demo buyer needs almost no test USDC. This has a consequence worth knowing before wiring real revenue into the investing loop. With the demo mandate (reserve target 2.00, opening reserve 1.50, invest share 5000 bps), a single `$0.01` sale is less than the model cost of the brief, so surplus is zero and nothing is invested. The `$3.00` figure in `demo-live.ts` is what makes that scene work. Before joining the two, either lower `reserveTargetUsdc` for the demo mandate or accumulate enough sales; do not quietly raise the price back.

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

Recommendation: set `BRIEF_PRICE_USD=$1.00` for the recorded demo and make three real purchases, keeping `$0.01` for cheap functional testing. Do not lower `minTradeUsdc`.

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