# Surplus

Surplus is a TypeScript decision and control layer for investing operating surplus into tokenized equities on Base. It is currently a library prototype: the repository contains the domain logic and data-survey scripts, but no production executor or user-facing application.

## What it does

The core package models a guarded investment workflow:

1. Record revenue, costs, reserves, proposals, approvals, and settlements in a balanced, replayable ledger.
2. Compute net surplus, top up the reserve, and split the remainder into investable and retained amounts.
3. Validate a versioned mandate containing eligible assets, theme targets, trade limits, slippage, and price-drift tolerances.
4. Preserve research provenance and validate claims, evidence, fit scores, and theme gaps.
5. Cross-check token API results against a curated Base registry before an asset can be considered trusted.
6. Inspect Base/USDC liquidity and turn research fits into weighted allocation candidates.
7. Allocate by theme using weighted water-filling while respecting company caps, maximum trade sizes, and minimum trade sizes.
8. Move proposals through an approval state machine and require re-approval when the mandate, proposal, approved maximum, or market prices drift.

All monetary values in the core domain are represented as `bigint` minor units (USDC units), avoiding floating-point arithmetic for accounting and allocation decisions.

## Repository layout

```text
packages/core/src/   Public TypeScript domain library
packages/core/test/  Vitest unit and property-style tests
scripts/             Snapshot and liquidity survey utilities
docs/                Captured token and liquidity API snapshots
apps/                Reserved for future applications
```

The package entry point is `packages/core/src/index.ts`, which re-exports the public API from the following modules:

- `money` — USDC formatting, basis-point arithmetic, and related helpers
- `ledger` — balanced transactions, balances, replay, modes, and idempotency
- `surplus` — reserve funding and surplus allocation
- `mandate` — mandate validation, canonical JSON, and hashing
- `policy` — proposal types and policy checks
- `research` — source/claim validation and candidate scoring
- `tokens` — Coinbase tokenized-stock API parsing, pagination, NAV freshness, and tradability checks
- `registry` — trusted Base token registry and API cross-checking
- `liquidity` — DexScreener parsing, Base/USDC pool selection, and liquidity scores
- `allocator` — constrained weighted allocation
- `approval` — proposal state transitions, approval hashes, price drift, and prechecks

## Requirements

- Node.js with native `bigint` and `fetch` support (Node 18+ recommended)
- npm

Install dependencies from the repository root:

```bash
npm install
```

## Development commands

Run the test suite:

```bash
npm test
```

Run TypeScript validation:

```bash
npm run typecheck
```

Both root scripts delegate to the `@surplus/core` workspace.

## Data survey scripts

The scripts use public HTTP APIs and write snapshots under `docs/`.

Fetch Coinbase tokenized-stock pages and save `docs/tokens.snapshot.json`:

```bash
node scripts/spike-tokens.mjs
```

Cross-check that snapshot against the curated registry, query Base/USDC pools from DexScreener, and save `docs/liquidity.snapshot.json`:

```bash
node scripts/survey-liquidity.mjs
```

Snapshots are point-in-time research inputs, not live execution data. Review their timestamps and refresh them before making decisions.
