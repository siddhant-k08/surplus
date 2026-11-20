# Surplus handoff notes

Written 21 Nov 2026 when the project moved from a Claude chat to Claude Code. The chat also produced a 10-section build plan, saved as a Claude doc titled "Surplus: Build Plan for Base Stocks Maxxing Season"; Siddhant has the link.

## Where we stopped

1. The research pipeline works end to end against real SEC filings and Gemini (`gemini-3.1-flash-lite`). Latest real run: 3 model calls, about 70,600 input tokens, cost about $0.021 booked at paid-tier rates, zero validation issues.
2. The keyword patch is applied and committed. `npm test` is 188 tests in 20 files.
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
- Last run: 12 legs, 0.991524 USDC total, 32 pre-trade gates ok, 0 warnings, 0 blocks, 12 simulated fills, `reconcileInternal` ok. longevity-biotech stays uninvested with reason `gap` and 1 unit lands as `unassigned` rounding.

Bug this found and fixed in core: `Treasury.execute` keyed fills `fill:<proposal>:<asset>`, so a proposal holding two legs for the same asset threw "Idempotency key reused with different content" and the whole loop died. Real research puts one company in several themes (TSLA, META, MSFT and AMZN each appear twice), which the placeholder fits never did. The key is now `fill:<proposal>:<legIndex>:<asset>`; legs are fixed when the proposal is created, so the index is stable across retries. Regression test added in `test/treasury.test.ts`.

## Open question for Siddhant, before mainnet

The 12 legs average about $0.083, and the quotes report about $0.0032 gas each, so roughly 4 percent per leg and about $0.038 total on $0.99 invested. Four of the ten tokens are bought twice because they sit in two themes, paying gas twice for the same token. Two possible answers, both his call because both change money semantics:

1. Merge legs with the same asset across themes before execution, keeping per-theme attribution in the ledger lines. Saves four swaps.
2. Raise `minTradeUsdc` so fewer, larger legs survive, and accept more uninvested money with reason `below_minimum`.

Nothing is changed here yet. The existing behaviour is correct, just gas-inefficient at these sizes.

## Next milestones, in order

1. x402 paid endpoint on Base Sepolia in `apps/api`. Verify package names and flow against the CDP seller quickstart (https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) before writing code. The free x402.org facilitator supports Base Sepolia only; mainnet needs the CDP facilitator. Needs a funded test wallet.
2. Web UI over the simulated loop (brief with quotes shown under each claim, proposal, approval, ledger). Simulation labels must be obvious.
3. Owner EIP-712 signature on approvals, persistence, deployment, onchain reconciliation.
4. Demo rehearsal, video, X post tagging @buildonbase, submission form. Re-check the Quest page rules on 24 Nov and 2 Dec, and re-read base.org/stocks before any mainnet use.
5. Real swaps only after Siddhant's explicit authorization, eligibility advice, a spend cap, the mainnet flag, and a throwaway wallet. Use fewer, larger legs (about $1 minimum): gas is 2 to 4 percent of a $0.10 leg.

## Core modules (packages/core/src)

money, ledger, mandate, surplus, policy, allocator (water-filling; leaves unplaceable money uninvested with reasons gap, company_cap, max_trade, below_minimum, unassigned), tokens (Coinbase token API, paginated by next_page_token), research (brief types, `validateBrief`, `isFactSupported`, `toCandidates(fits, liquidity, floor = 3, minLiquidity = 0)`), approval (proposal state machine), registry, liquidity (DexScreener per-token endpoint), reconcile, treasury, quote (KyberSwap), gates, pipeline (research orchestration and verification; `quoteCheck` gives the per-quote verdict, `quoteInText` wraps it, `mentionsAny` is the theme-relevance rule), edgar (SEC client and doc provider), anthropic, gemini.

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