# Running Surplus on a server

What a working deployment needs, and why each part is there. Written 21 Nov 2026.

Nothing here provisions anything for you. The accounts, the machine and the money are yours to set up;
this is the list and the reasoning so none of it is guesswork at the wrong moment.

## What the machine has to provide

A small VPS is enough. One Node 22 process, a few hundred megabytes of memory, and a disk.

**Either a disk or a database.** The ledger, the mandate history, the receipts and a buyer's
commissioned brief are all written while the agent runs, and their integrity is the product. With the
JSONL files, a filesystem that resets between deploys loses the agent's books and the hash chain that
proves nobody edited them. Set `DATABASE_URL` and the same records become rows in Postgres instead,
which is what makes serverless hosting possible: see "Postgres instead of files" below.

## Postgres instead of files

`DATABASE_URL` is the whole switch. Empty means the JSONL files; a connection string means Postgres,
and the startup banner says which is live (`storage  postgres (DATABASE_URL)`). The schema is created
on start when it is absent; every statement is `create ... if not exists`, so starting repeatedly is
safe and nothing is ever dropped or rewritten.

What moves, and what does not:

| Record | With `DATABASE_URL` | Why |
|---|---|---|
| Sales ledger | `ledger_entries`, book `sales-<mode>` | written on every settlement |
| Investing ledger | `ledger_entries`, book `invest-<mode>` | written on every sync, proposal and fill |
| Mandate history | `mandate_versions` | written whenever the owner changes a term |
| Receipts | `receipts` | written on every purchase |
| Buyer-commissioned briefs | `briefs`, collection `custom` | generated and stored per paid request |
| Sessions and sign-in nonces | `sessions`, `login_nonces` | a cookie issued by one instance must work on the next |
| The owner's catalogue | still `BRIEFS_DIR` on disk | repository content, read-only at runtime |

The money rules are unchanged, because the database keeps the same ones: amounts are stored as decimal
strings of USDC minor units and parsed by the same parser the files use, appends are idempotent on the
key that identifies the entry, and a book whose entry ids are not contiguous from 1 refuses to load.
Nothing in the ledger or the mandate history is ever updated or deleted.

Use the provider's pooled connection string if there is one. Note what pooling costs: a transaction-mode
pooler reuses one server connection across clients and does not reliably reset session state, so the app
never sets `search_path` and the tables live wherever the role's default puts them, normally `public`.

### Moving the existing books in

Run this once, after setting `DATABASE_URL`:

```bash
npm run db:import -w @surplus/api            # prints what it would copy, writes nothing
npm run db:import -w @surplus/api -- --apply # copies it
```

It reads the JSONL files, writes each record to the database, and reads them back to check the entry
ids, settlement transactions and idempotency keys survived. It never modifies the files, and running it
twice writes nothing the second time. Keep the files afterwards: they are the backup of what was
imported.

## Serverless, on Vercel

Live at https://surplus-eosin-seven.vercel.app (project `surplus`, deployed 21 Nov 2026).

`vercel.json` names one build command and nothing else; `scripts/build-vercel.mjs` produces the whole
deployment through the platform's Build Output API:

```
.vercel/output/config.json                     routing: the API paths to the function, the rest to the app
.vercel/output/static/                         the web app, served as files
.vercel/output/functions/api.func/index.mjs    the bundled server
.vercel/output/functions/api.func/docs/briefs  the owner's catalogue, read at runtime
```

The simpler `functions` glob was tried first and is the wrong tool here: it matches patterns against the
files in the repository, and the function is a bundle this build produces rather than a file anyone
commits. A deploy from a laptop worked because the bundle was already there and got uploaded with the
source; the same commit pushed to git failed with `unused_function`, because in a fresh clone the
pattern matched nothing. Writing the output directly means both paths run the same script. The function assembles the agent once per
instance and serves every API route; `apps/web/dist` is served as static files by the platform, with
anything unmatched falling back to `index.html` for the single-page app.

What it needs, and why:

- **`DATABASE_URL` is mandatory here.** A serverless instance may be replaced between any two requests.
  With the JSONL files, a settlement written by one instance would not be there for the next, and the
  mandate would come back as whatever the code shipped. `GET /health` and the startup log both say which
  storage is live, so this is checkable rather than assumed.
- Every other variable from the table above goes in the project's environment variables. There is no
  `.env` on the host; the app falls back to the process environment, which is what Vercel provides.
- `maxDuration` is 60 seconds because generating a brief calls SEC EDGAR and then a model. A paid request
  that is cut off mid-generation is the one failure mode worth paying attention to after the first
  deploy: the buyer's payment settles and their brief does not arrive.
- The build copies `docs/briefs` into the function. Without it the catalogue is empty on the host and
  `GET /brief` has nothing to sell, with no error anywhere: `GET /health` just reports no brief.
- Checks worth making on the first deploy, in this order: `GET /health` reports `postgres`; `GET /brief`
  answers 402 rather than 500; the owner desk loads; sign-in sticks across a page reload (this is the one
  that proves sessions really are in the database); a receipt link opens the brief it paid for.

### Two things the host does that broke the first deploy

Both failed the same way, with every API route returning 500 while the static site served fine.

1. **The function must be bundled before it is uploaded.** Vercel's builder transpiles a TypeScript
   function without bundling it, which leaves extensionless relative imports Node cannot resolve and a
   CommonJS wrapper around ESM syntax. `npm run build:serverless` bundles `apps/api/src/serverless.ts`
   into `api/index.mjs` with esbuild, which also resolves `@surplus/core`, whose entry point is
   TypeScript source rather than built JavaScript. The output is ESM because the code uses
   `import.meta.url`, and it carries a `createRequire` banner because `debug`, reached through Express,
   calls `require("tty")` dynamically and an ESM bundle has no `require`.
2. **The deployment root is not where the code thinks it is.** `REPO_ROOT` is derived from the module's
   own location, which is right for `apps/api/src` and points above the deployment for a bundle sitting
   at the root. The serverless entry sets `SURPLUS_ROOT` from the working directory before anything
   reads it. Without that the catalogue resolved to `/docs/briefs`, and the symptom was not an error:
   every route answered, `GET /health` returned `"latestBrief": null`, and the agent had nothing to sell.

The rewrites do leave the original path on the request, so one Express app serves every route. Verified
on the deployment, not assumed.

Each cold start logs one line (`vercel logs --deployment <url>`) naming the storage, the root, how many
briefs the catalogue holds, the mandate version and the sales booked. Those are the things that can be
wrong while every route still answers.

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
| `X402_PAY_TO` | Where USDC lands. Real revenue on mainnet, so be sure you hold its key |
| `X402_NETWORK` | `eip155:84532` (default) or `eip155:8453`. A typo stops the server from starting |
| `PUBLIC_LEDGER` | `true` publishes the sales book. The transparency is the pitch, but it is your financial history |
| `MAINNET_ENABLED` | Needed for mainnet sales or swaps. A decision about real money, not a deploy step |
| `EXECUTION_PRIVATE_KEY` | Empty unless real swaps are deliberately on. Empty means simulated fills |
| `MAINNET_SPEND_CAP_USDC` | The ceiling the executor refuses to pass. No default, on purpose |
| `RESEARCH_TOTAL_MAX_USD` | Ceiling on model spend for the life of the process |
| `DATABASE_URL` | Empty keeps the books in the JSONL files; a connection string moves them to Postgres |

## Selling on Base mainnet

Live since 27 Nov 2026. Investing stays simulated.

| Variable | Value |
|---|---|
| `MAINNET_ENABLED` | `true` |
| `X402_NETWORK` | `eip155:8453` |
| `X402_FACILITATOR` | `local` |
| `FACILITATOR_PRIVATE_KEY` | a wallet holding a little ETH on Base, not the trading key |
| `BASE_RPC_URL` | a Base mainnet endpoint |
| `INVEST_MODE` | `sim` |
| `EXECUTION_PRIVATE_KEY` | not set, so no swap can be sent |
| `FACILITATOR_RPC_URL`, `APPROVAL_CHAIN_ID` | not set, so neither can point at Sepolia |

Redeploy after changing them, then read `GET /health`: `ok` true, `network` `eip155:8453`, and the
facilitator naming the settlement wallet. If every route answers 503, the reason is the `startup_failed`
line in the logs (`vercel logs --environment production`). The first switch failed that way, on
`eip155:8543` typed for `eip155:8453`.

The mainnet sales book is a new one, so the public sales count starts at zero. The first sale used
0.00000062 ETH of gas from the settlement wallet and none from the buyer.

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

With `DATABASE_URL` set, this is the provider's job: take their backups or snapshots of the whole
database, and keep the JSONL files from before the import as the record of everything up to that point.
Nothing else in the deployment holds state that cannot be recomputed.

With the files, everything that cannot be recomputed lives in `data/`:

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

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, the scripts typecheck, the
whole test suite against a real Postgres service container, and a full build of the deployment. The
money rules are the test suite, so nothing should reach the agent without passing it.

The Postgres suites create and drop their own schema per test, so they are safe against any database
the job can reach; in CI that is a throwaway container, never the live one.

## Backups you hold yourself

```bash
npm run db:export -w @surplus/api                # data/export-<timestamp>/
npm run db:export -w @surplus/api -- --out=path  # somewhere specific
```

Writes the ledgers, the mandate history and every receipt as the same JSONL the file backend reads, so
a copy can be replayed rather than merely read. The export reads back what it wrote and refuses to
claim success if it does not load.

`.github/workflows/backup.yml` runs that nightly, once for each network, and keeps the result as an
encrypted artifact for 90 days. It needs two repository secrets: `DATABASE_URL`, and `BACKUP_PASSPHRASE`
of at least 20 characters. Keep the passphrase in a password manager: nothing can open a backup without
it, and changing it does not re-encrypt the old ones. The provider's own backups are theirs and
retention on a small plan is short, which is the point of holding your own.

The repository is public, so only the encrypted archive is uploaded and the export prints nothing to the
job log. To open one, download it, decrypt it (gpg asks for the passphrase) and unpack it into `data/`,
which git ignores:

```bash
gh run download <run-id> --name books-<run-id> --dir data/restore
gpg --decrypt --output data/restore/books.tar.gz data/restore/books.tar.gz.gpg
tar -xzf data/restore/books.tar.gz -C data/restore
```

## Limits on the open routes

Four routes are neither paid for nor signed: the two nonce routes and the two that spend a nonce. Each
is capped at 20 calls a minute per caller, counted in the database so the limit is one limit however
many instances are running. The nonce routes write a row per call, so without this an anonymous caller
could grow a table in your database for nothing.

A limiter that cannot answer lets the request through and logs it. The ceiling exists to stop abuse,
not to become a dependency that can take the API down.

## Checking it is alive

`GET /health` answers without authentication and says the mode, which storage is live, the network, the
price, the brief on offer and how many sales are booked. It is the right thing for a monitor to poll,
and `"storage": "files"` on a serverless host is the one answer that means something is wrong.

It also checks its dependencies rather than merely answering, and returns **503** when it cannot do its
job:

| Check | Meaning | Healthy? |
|---|---|---|
| `storage` | the database answered just now, not merely at start-up | 503 if not |
| `books` | the ledger reconciles: balanced, replayable, no impossible negative | 503 if not |
| `catalogue` | there is a brief to sell | reported, never a fault |

Point an uptime monitor at it (Better Stack, UptimeRobot and the like are free at this size) and alert
on the status code. That is the whole alerting story: the endpoint is honest about being unhealthy, so
anything that watches HTTP status is enough.

### The log lines worth alerting on

Operational events are one line of JSON each, with a stable `event` name, so a drain can alert on the
thing rather than on a phrase someone may reword:

| `event` | Means | Worth waking someone? |
|---|---|---|
| `sale_not_recorded` | a payment settled and storage refused the write | **yes** |
| `execution_unresolved` | a signed swap whose outcome is still unknown | **yes** |
| `startup_failed` | an instance could not assemble, usually the database | yes, if it persists |
| `settled_wrong_asset` | a payment arrived in something other than the expected USDC | yes |
| `rate_limit_unavailable` | the limiter could not answer; requests were let through | worth knowing |
| `sale_booked`, `brief_generated`, `execution_recovered`, `assembled` | normal operation | no |

Every line also carries a readable `message`, because logs are read by people more often than by
machines.

Credentials are redacted on the way out: connection strings, bearer tokens, and anything labelled as a
key or a secret. Redaction is by context and never by shape, because a private key and a transaction
hash are both 32 bytes of hex, and masking that shape would destroy the field `sale_not_recorded`
exists to carry.

A deeper check needs the owner token:

```bash
curl -s -H "Authorization: Bearer $OWNER_TOKEN" https://your-host/invest/ledger | jq .reconcile
```

`{"ok": true, "issues": []}` means the books balance, replay cleanly and hold no negative balance where
one would be impossible. If that ever turns false, stop and read it before doing anything else.

## A first real swap, deliberately

Checked on Base mainnet, 22 Nov 2026, read only: a $1.00 and a $0.25 quote for NVDAc, MSFTc and AAPLc
all returned, with the price 1.5 to 2.2 percent above NAV and **the same at both sizes**, so at this
scale the spread is the premium over NAV rather than price impact. Liquidity scores were 3 to 5 against
a gate that needs 2. The NAV gate blocks above 3 percent, so NVDAc at 2.2 percent passes but is not far
off; a quiet market day is a better day for this than a loud one.

What that means in practice: a swap of 50 cents proves the path as well as a swap of fifty dollars, and
gas on Base is cents. Exposure should be a few dollars at most.

### The books have to stay honest about where the money came from

Revenue earned on one network cannot fund trades on another, and `syncRevenue` refuses to mirror across:
a mainnet book fed by testnet revenue would have the agent spending real money while its books claimed it
had earned it. Those sales are reported as `refusedSales` rather than silently skipped.

Since selling moved to mainnet, a mainnet investing book can mirror mainnet sales. Two things still hold:

- It starts as a new book. Owner capital is what `OPENING_FLOAT_USDC` records, labelled "owner-provided
  working capital".
- Revenue arrives in the `X402_PAY_TO` wallet. The trading wallet receives none of it until someone moves
  it there, so check that wallet's balance against what the book says is investable.

### Rehearse it first

```bash
npm run preflight -w @surplus/api -- --symbol=NVDAc --usdc=0.50
```

Everything a real swap does, stopping before the broadcast: the trusted set, liquidity, a live quote,
the pre-trade gates, the wallet's USDC and gas, the calldata, and the chain's own answer to whether the
swap would succeed. Nothing is signed and nothing is sent. It is not a separate implementation of the
path: it builds the same calldata through the same code, so what it reports is what would happen.

It runs with no wallet configured too, and reports the market side only, which is a useful thing to look
at on its own.

**One thing it taught us immediately.** The NAV deviation gate blocks only when NAV is fresh, so it is
inert whenever the underlying market is closed, which is exactly when the premium to NAV is widest and
least checkable. A preflight run on a Saturday reported NAV 34 hours old and the deviation check
skipped, with the quote 2.2 percent above NAV and nothing to stop it being 10. **Do a first real swap
during US market hours**, when the gate is actually doing its job.

### The order to do it in

1. Complete a mainnet sale first (see "Selling on Base mainnet"), so payment, settlement and receipt are
   proven before the agent can spend anything.
2. Fund a throwaway wallet on **Base mainnet** with a few dollars of USDC and a little ETH for gas.
   USDC on Ethereum mainnet is on the wrong chain: it has to be bridged to Base first, and that costs
   Ethereum gas, which on a small amount is a meaningful fraction of it.
3. Set `MAINNET_ENABLED=true`, `MAINNET_SPEND_CAP_USDC` to what you would be relaxed to lose,
   `EXECUTION_PRIVATE_KEY` to the throwaway key, `INVEST_MODE=mainnet`, and `OPENING_FLOAT_USDC` to the
   capital you are putting in.
4. Run the preflight above against the funded wallet and read every line of it.
5. Propose, approve with the owner wallet, and execute **one order at the minimum trade size**, watching.
   The journal records the signed transaction before it is broadcast, so an interrupted run is
   recoverable rather than a mystery.
6. Run the position check: `GET /invest/positions` with the owner token. It compares the units the
   agent recorded receiving against the chain's own answer for the wallet, with no price involved.
   Short means the books claim tokens the wallet does not hold, which needs a person before anything
   else happens. Extra is reported and is not a failure: the agent is not the only thing allowed to
   put tokens in that wallet.
7. Check `GET /invest/ledger`: the fill carries the real transaction hash, the quantity is what the
   chain returned, and `reconcile.ok` is still true.

## Turning on real swaps

Not a deploy step. It needs the owner's explicit decision, then a funded throwaway wallet,
`MAINNET_ENABLED=true`, `INVEST_MODE=mainnet`, a `MAINNET_SPEND_CAP_USDC` you would be relaxed to lose,
and `EXECUTION_PRIVATE_KEY`. The executor refuses to exist if the flag, the cap or the key is missing, and
the startup banner says `execution  simulated (...)` with the reason whenever it has refused.
