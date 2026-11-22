# Surplus frontend design plan

Written 22 Nov 2026, before the desktop-first redesign of the three surfaces. The identity is given and
is not up for redesign: navy, cream, coral, Archivo and Newsreader. What follows is how those are spent.

## The subject decides the treatment

Two products share one bundle and they are not the same kind of thing.

A brief is a **document**: prose, quotations, citations, something a person reads and checks. The desk is
an **instrument**: balances, limits, states, a sequence of irreversible actions. Designing both as the
same grid of rounded cards would flatten the only distinction that matters to a reader.

So the one deliberate editorial move: **Newsreader carries claim text and quoted filing prose; Archivo
carries every number, label, control and state.** The research reads like a document even inside the
desk, and the treasury reads like an instrument even on the storefront. Nothing else changes font.

## Tokens

Colour, named. The first five are the established identity and are unchanged.

| Token | Value | Job |
|---|---|---|
| `--navy` | `#14213D` | raised surface |
| `--navy-deep` | `#0A1023` | page ground |
| `--cream` | `#F4EDE0` | primary ink |
| `--cream-dim` | `#9AA3B8` | secondary ink, labels |
| `--coral` | `#FF6B5B` | the one action meant to be pressed, and alarm |
| `--sim` | `#7FA6C9` | simulated, rehearsal, nothing moved |
| `--good` | `#5FB49C` | reconciled, quote found verbatim |

`--sim` and `--good` exist because the desk has to say "this is a rehearsal" and "the books agree" in a
glance, and neither may borrow coral: coral is how the page says something is wrong or something is
about to happen. Both are desaturated on purpose so coral stays the loudest thing on any screen.

Type: `--ui` Archivo 400/500/600/700, `--doc` Newsreader 400 and 400 italic. Scale 0.75, 0.8125, 0.875,
1, 1.1875, 1.375, 1.75, clamp(2, 6vw, 3) rem. Running prose at 62ch, quoted filing text at 68ch with
Newsreader's extra line-height.

## Layout principles

1. **Desktop first, two columns.** A content column that reads top to bottom, and a rail that answers
   "where do I stand" without being scrolled to. 78rem maximum, equal left and right edges.
2. **One decision per screen on the desk.** The current step owns the first screen. Ledger,
   reconciliation, positions and mandate stay reachable and never crowd the action.
3. **Evidence is progressive disclosure, never summary.** A row says how much evidence it has; opening
   it shows *every* claim and *every* quote with its source link. Nothing is summarised away, because
   the ability to check is the product.
4. **State is text, not vibe.** Loading, empty, refused, busy, expired and failed each say what is true
   and what to do. Reasons come from the API verbatim; the page never invents one.
5. **Numbers are tabular and monetary values are strings.** Formatting happens once, at display.

## Wireframe, storefront at 1440

```
+--------------------------------------------------------------------+
| Surplus                      Briefs   How it works   Owner desk    |
+--------------------------------------------------------------------+
| Research you can check, line by line.                              |
| lede, 54ch                                                         |
|                                                                    |
| +-- Ready now ---------------+  +-- Made to order ---------------+  |
| | Latest brief        $0.01  |  | Your own themes         $0.50  |  |
| | 3 themes 12 facts 7 filings|  | up to 3 themes, same rules     |  |
| | what you get: ...          |  | takes about a minute           |  |
| | [ Buy the latest brief ]   |  | [ Choose your themes ]         |  |
| +----------------------------+  +--------------------------------+  |
| one state line: no wallet / no brief / paying / paid / failed       |
+--------------------------------------------------------------------+
| How a brief is built            1 filings 2 quotes 3 fits 4 gaps    |
+--------------------------------------------------------------------+
| Commission your own themes   [textarea]      [ Commission it ]      |
+--------------------------------------------------------------------+
| Lost your link?  recover with the wallet that paid                  |
+--------------------------------------------------------------------+
```

Both paths get a card of equal width, equal type scale and a real button. They are deliberately **not**
symmetrical in content: the left card shows the actual counts of a brief that exists, the right card
shows the rules and the wait for research that does not exist yet. Equal weight, different substance.

## Wireframe, receipt at 1440

```
+--------------------------------------------------------------------+
| Surplus                                           Back to briefs   |
| Your brief                     | 0.010000 USDC, 22 Nov 2026        |
| 3 themes, 7 filings            | settlement 0xcd71...  [on Base]   |
+-----------------------------------+--------------------------------+
| ai-compute                        | Filings            (sticky)    |
|  TSLA     fit 4/5   2 claims [v]  |  TSLA 10-K      sec.gov ^      |
|    claim, Newsreader              |  GOOGL 10-K     sec.gov ^      |
|    "quoted filing text"           |                                |
|    source title, filed 2026-01 ^  | What a quote proves            |
|  GOOGL    fit 3/5   1 claim  [>]  |  short note                    |
+-----------------------------------+--------------------------------+
| disclaimer                                                         |
+--------------------------------------------------------------------+
```

## Wireframe, desk at 1440

```
+--------------------------------------------------------------------+
| Surplus        Decision  Mandate  Book       v2 8a3f..   [sign out]|
+--------------------------------------------------------------------+
| 1 Sync -> 2 Propose -> 3 Review -> 4 Sign -> 5 Execute              |
|                      ^ current                                      |
+-----------------------------------+--------------------------------+
| Step panel                        | Where you stand   (sticky)     |
|  headline for this step           |  investable  0.000000          |
|  what happens when you press it   |  reserve     0.000000          |
|  [ primary ]   secondary          |  mandate     v2 8a3f..         |
|  SIMULATED / REAL, said explicitly|  books       reconciled        |
|  reasons from the API, verbatim   |  chain       nothing to compare|
+-----------------------------------+--------------------------------+
| Evidence behind this proposal: every claim, every quote            |
+--------------------------------------------------------------------+
| Mandate: grouped terms, edit, review changes, save, history + chain |
+--------------------------------------------------------------------+
| The book: append-only entries, mode tag per line                    |
+--------------------------------------------------------------------+
```

## Critique, against the brief and against my own defaults

- **Two cards in a hero is the SaaS pricing recipe.** Guarded against by making them asymmetrical in
  content and by giving neither a "most popular" treatment. If they had held the same three bullet
  shapes I would have rebuilt one of them as prose.
- **Numbered steps are the commonest false signal in generated design.** Kept in exactly two places
  because both really are ordered: a brief cannot have fits before it has quotes, and an owner cannot
  sign a proposal that does not exist. Dropped everywhere else.
- **A dashboard wants charts.** Refused. There is no series here worth a chart: the interesting numbers
  are a handful of balances and one distance to a threshold, and a sparkline of four sales would be
  decoration pretending to be information.
- **The rail could become a second navigation.** It holds state, never actions, so there is one place to
  act on each screen.
- **Progressive disclosure can hide the product.** Every row says how much evidence it holds before it
  is opened, so disclosure never conceals whether there is anything to open.
