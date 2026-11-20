# Surplus handoff notes

Written 21 Nov 2026 when the project moved from a Claude chat to Claude Code. The chat also produced a 10-section build plan, saved as a Claude doc titled "Surplus: Build Plan for Base Stocks Maxxing Season"; Siddhant has the link.

## Where we stopped

1. The research pipeline works end to end against real SEC filings and Gemini (`gemini-3.1-flash-lite`). Latest real run: 3 model calls, about 70,000 input tokens, cost about $0.021 booked at paid-tier rates, zero validation issues.
2. A patch was just handed over and may not be applied yet. Check with `npm test`: 187 tests means applied, 182 means not. The patch:
   - `ThemeSpec` gains optional `keywords`. A fit survives only if one of its supporting quotes mentions a keyword (`mentionsAny`, whole word or phrase, case-insensitive). Evidence counts only supporting facts that pass this.
   - When a fact is dropped for a non-verbatim quote, the message includes `Tried: "<first 120 chars of the attempted quote>"`.
   - `keywordsFor` (passage selection) also uses the theme keywords.
   - `scripts/demo-research.ts` THEMES get keyword lists (ai-compute, platform-giants, longevity-biotech).
   - Five new tests: `mentionsAny`, keyword drop, attempted-quote message.
3. Open diagnosis: in the last run, NVDA, MSFT and AMZN dropped out of ai-compute because their quotes were not verbatim. After the patch, rerun `demo-research.ts` and read the `Tried:` lines. If the model paraphrased, it is a Flash-Lite limit: keep Flash-Lite for testing, use a Flash model for the recorded demo. If a quote looks exact but failed, `htmlToText` in `src/edgar.ts` is altering filing text; fix it.
4. Also seen in the last run: Alphabet got fit 3 in longevity-biotech from a quote about X, its moonshot factory. The keyword patch is meant to stop that; confirm longevity-biotech comes out as a gap.

## Next milestones, in order

1. Close the research-quality loop above.
2. Integration: make `demo-live.ts` use the latest real brief from `docs/briefs/` instead of placeholder fits, and book the real model cost with `Treasury.accrueCost({ kind: "llm", ... })`, memo "metered estimate at paid-tier rates". Result: research, booked cost, surplus, allocation, real quotes, simulated fills, reconciled ledger.
3. x402 paid endpoint on Base Sepolia in `apps/api`. Verify package names and flow against the CDP seller quickstart (https://docs.cdp.coinbase.com/x402/quickstart-for-sellers) before writing code. The free x402.org facilitator supports Base Sepolia only; mainnet needs the CDP facilitator. Needs a funded test wallet.
4. Web UI over the simulated loop (brief with quotes shown under each claim, proposal, approval, ledger). Simulation labels must be obvious.
5. Owner EIP-712 signature on approvals, persistence, deployment, onchain reconciliation.
6. Demo rehearsal, video, X post tagging @buildonbase, submission form. Re-check the Quest page rules on 24 Nov and 2 Dec, and re-read base.org/stocks before any mainnet use.
7. Real swaps only after Siddhant's explicit authorization, eligibility advice, a spend cap, the mainnet flag, and a throwaway wallet. Use fewer, larger legs (about $1 minimum): gas is 2 to 4 percent of a $0.10 leg.

## Core modules (packages/core/src)

money, ledger, mandate, surplus, policy, allocator (water-filling; leaves unplaceable money uninvested with reasons gap, company_cap, max_trade, below_minimum, unassigned), tokens (Coinbase token API, paginated by next_page_token), research (brief types, `validateBrief`, `isFactSupported`, `toCandidates(fits, liquidity, floor = 3, minLiquidity = 0)`), approval (proposal state machine), registry, liquidity (DexScreener per-token endpoint), reconcile, treasury, quote (KyberSwap), gates, pipeline (research orchestration and verification), edgar (SEC client and doc provider), anthropic, gemini.

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

## Environment (.env, never committed)

`MODE`, `MAINNET_ENABLED`, `MAINNET_SPEND_CAP_USDC`, `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SEC_USER_AGENT`, `LLM_PROVIDER`, `RESEARCH_MODEL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PRICE_INPUT_PER_MTOK_USD`, `PRICE_OUTPUT_PER_MTOK_USD`, `RESEARCH_MAX_USD`. Prices are paid-tier rates even on a free tier so the ledger books a realistic cost.

## Lessons from earlier milestones

- Never run `npm audit fix --force` (it would jump vitest majors). Use `npm audit --omit=dev`.
- Scripts use top-level `async function main()`; tsx runs them as CommonJS-compatible.
- `scripts/tsconfig.json` sets `"types": ["node"]`; without it editors report `Cannot find name 'process'`.
- A KyberSwap or DexScreener survey that prints raw JSON is too long to paste; summarize in the script.