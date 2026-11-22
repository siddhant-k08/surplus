# Surplus

An agent that sells cited stock research for USDC, books what it costs to run, and invests only a
share of what is genuinely left over, inside constraints its owner sets and signs for.

Live: **https://surplus-eosin-seven.vercel.app**

It sells briefs built from SEC filings where every fact carries the sentence it came from. Payment is
x402 over USDC on Base. Revenue, model costs and a protected reserve go into a double-entry ledger, and
whatever survives that is the only money the agent may invest. Every trade needs the owner's signature,
material price movement voids it, and nothing is booked that did not happen.

## What is real, and what is not

Being specific about this matters more than the feature list.

| | State |
|---|---|
| Selling briefs for USDC | **Real.** Base Sepolia, settled onchain, booked from confirmed settlements |
| Research from SEC filings | **Real.** EDGAR 10-K and 10-Q, verified quote by quote |
| The books, the mandate, receipts | **Real**, in Postgres, append-only, hash chained where it matters |
| Buying tokenized stocks | **Simulated**, and labelled as simulated everywhere it appears |

The reason for that last row is not effort. Selling runs on Base Sepolia because that is the only
network the free x402 facilitator serves, and Coinbase's tokenized stocks exist only on Base mainnet.
Testnet revenue cannot fund a mainnet swap, and the agent refuses to pretend otherwise: it will not
mirror revenue earned on one network into a book that trades on another. The execution path is built,
tested and gated behind `MAINNET_ENABLED`; turning it on is a decision about real money, not a deploy
step.

## How a brief earns the right to exist

1. Filings are pulled from SEC EDGAR, never from a summary or a news article.
2. A fact survives only if a 20 to 300 character quote appears verbatim in a document it cites, and
   every number in the fact appears in that quote.
3. A company reaches a theme only through a surviving fact from its own filing. Evidence is counted in
   code; the model never scores itself.
4. When nothing clears the bar, the theme comes back as a declared gap. An empty answer is more useful
   than a confident one with nothing behind it.

Source documents are untrusted input. So are buyer-supplied themes. Verification is the defence, not
the prompt.

## How the money works

- Amounts are `bigint` USDC minor units. No floats touch money, anywhere.
- The ledger is double-entry, append-only, idempotent on the key that identifies an entry, and
  replayable. Replaying restores the deduplication index, which is what stops a settlement booking
  twice after a restart.
- Settlement is incremental: a brief can earn again, and the new revenue reaches the surplus too.
- Costs are attributed per brief. Every brief the agent produced cost money, whether or not anyone
  bought it.
- The mandate is versioned and hash chained. An altered history makes the server refuse to start. The
  agent never changes the owner's constraints.
- An approval binds to the proposal hash, the mandate version and hash, a maximum spend and an expiry,
  and is signed EIP-712 by the owner's wallet. Drift beyond tolerance means re-approval.
- Money that cannot be placed stays uninvested, with a stated reason.

## Running it

Node 22. From the repository root:

```bash
npm install
cp .env.example .env     # nothing has a default that spends money
npm test                 # the money rules are the test suite
npm run build:web        # the API serves apps/web/dist
npm run api              # the agent, on PORT (default 4021)
```

`DATABASE_URL` decides where the books live: empty keeps them in append-only JSONL files, a connection
string puts them in Postgres. A database is not optional on a host that can replace the process between
two requests, which is most serverless hosting. `GET /health` says which is live and answers 503 when
storage is unreachable or the books do not reconcile.

Other things worth knowing:

```bash
npm run preflight -w @surplus/api -- --symbol=NVDAc --usdc=0.50   # a real swap, stopping before the broadcast
npm run db:export -w @surplus/api                                 # the books out as JSONL, for a backup you hold
npx tsx scripts/demo-sim.ts                                       # the whole loop, fully simulated
```

`docs/DEPLOY.md` is the operational detail: deployment, limits, backups, what to alert on, and the
order to do a first real swap in. `docs/HANDOFF.md` is the running record of decisions, verified facts
and open questions.

## Layout

```text
packages/core/   the domain: money, ledger, mandate, surplus, allocator, research, approval, gates
apps/api/        the paid endpoint, the investing engine, storage backends, the executor
apps/web/        the storefront, the receipt page and the owner desk
api/             the serverless entry point, bundled by the build
scripts/         runnable demos and read-only spikes
docs/            deployment notes, the handoff record, and saved briefs
```

## Limits, stated plainly

- Research output is informational. It is not investment advice, personalised or otherwise.
- NAV is a reference value, never an execution price, and the deviation gate only blocks when NAV is
  fresh, which it is not while the underlying market is closed.
- Liquidity scores are a heuristic.
- The trusted token set is Base's published registry intersected with Coinbase's API, read on a date
  recorded in the code. Recheck it before any mainnet use.
- Whether buying tokenized equities is lawful for a given person in a given country is a question for
  someone qualified, and nothing here answers it.

## License

None declared yet. Settle that before distributing.
