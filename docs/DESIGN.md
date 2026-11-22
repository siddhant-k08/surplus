# Surplus frontend design

Rewritten 23 Nov 2026, when the one scrolling page became a site. The previous plan described a navy,
cream and coral identity across three surfaces; both the palette and the shape of the app have moved
on, so this replaces it rather than amending it.

## The subject decides the treatment

Two products share one bundle and they are not the same kind of thing.

A brief is a **document**: prose, quotations, citations, something a person reads and checks. The desk
is an **instrument**: balances, limits, states, a sequence of irreversible actions. Designing both as
the same grid of rounded cards would flatten the only distinction that matters to a reader.

The agent's whole claim is that it shows its working, so the design is built around evidence rather
than around persuasion: a claim is shown with the sentence from the filing under it, a figure is shown
with the ledger line behind it, and a failure is shown rather than smoothed over.

## Pages, and why they are separate

Reading about a product and using it are different states of mind, and one scrolling page that tried
to be both was neither. The nav names places, not sections of a document.

| Path | What it is | Can it move money |
|---|---|---|
| `/` | The landing page. What the agent does, how a brief is built, what the treasury does. | No. Nothing on it wakes a wallet. |
| `/themes` | Every theme researched, the companies found under each, and how often a theme came back empty. | No |
| `/filings` | Every SEC document read, newest first, each linking out to EDGAR. | No |
| `/app` | The counter: connect, buy the latest brief, or commission your own themes. | Yes |
| `/app/portfolio` | One wallet's briefs, spend and balance, opened by a signature. | No. The signature authorises reading. |
| `/r/<id>` | A bought brief. | No |
| `/desk`, `/desk/mandate`, `/desk/book` | The owner's treasury desk, behind a wallet sign-in. | Yes, and every trade is signed on its own. |

`/library` and `/store` were the old paths; both are replaced in history rather than left to 404.

The desk is lazily loaded (`Owner.tsx`). Exactly one person will ever open it, and a visitor reading
the landing page should not download the controls for someone else's treasury.

## Tokens

The whole look is `apps/web/src/theme.css` as Tailwind v4 `@theme` tokens. Components use tokens and
never a raw hex value.

| Token | Value | Job |
|---|---|---|
| `--color-soot` | `#0f0f0f` | page ground |
| `--color-surface` | `#171717` | a panel that holds evidence or a ledger |
| `--color-pill` | `#202020` | a chip, a symbol, a step number |
| `--color-line` | `#272727` | every rule and border |
| `--color-ink` | `#ffffff` | headings, figures, the thing being said |
| `--color-dim` | `#8d8d86` | running prose and labels |
| `--color-faint` | `#5c5c58` | placeholders and struck-out claims |
| `--color-lime` | `#dafa9c` | the one action meant to be pressed, and the mark that says verified |
| `--color-amber` | `#ffa05c` | real money, or a gap worth noticing |
| `--color-flag` | `#ff6b5b` | dropped, refused, failed |

Lime is rationed. It is the button, the verified mark and nothing else, so a page never has two things
competing to be pressed. Amber and red both mean "look at this", and the difference is that amber is
about money being real while red is about something not having worked.

Type: Archivo for everything structural, DM Mono for every number, identifier, hash and label. A figure
that lines up in a column is tabular (`.num`). Running prose stays at 62ch (`.measure`).

## Layout principles

1. **Nothing is centred.** `.band` is a 14rem label spine and a content column, repeated down every
   page, so the eye has one left edge to return to. `.shell` is 84rem with equal gutters.
2. **Borders, not cards.** A ruled row reads like the ledger the numbers come from; four rounded
   panels floating on a dark ground reads like a template.
3. **State is text, not vibe.** Loading, empty, refused, busy, expired and failed each say what is
   true and what to do. Reasons come from the API verbatim; the page never invents one.
4. **Evidence is progressive disclosure, never summary.** A row says how much evidence it has; opening
   it shows every claim and every quote with its source link.
5. **Numbers are tabular and monetary values are strings.** Formatting happens once, at display, and
   never through a float.

## Motion

All of it goes through `src/motion.tsx`, which wraps `LazyMotion` with `domAnimation` and re-exports
`m` as `motion` in `strict` mode: importing `motion` from the package directly ships the heavy bundle
and strict mode throws rather than letting that happen quietly.

Three rules. One easing for everything, so the app has a single sense of weight. Nothing moves that is
not saying something: the verification pass strikes claims out because the agent really drops them, the
ledger keeps arriving because it really does, the stage line draws because the stages really are
ordered. And every animation ends in the state the element would have had anyway, so
`prefers-reduced-motion` removes the movement and never the content.

## Wallets

wagmi holds one account and one chain for the whole app (`src/wagmi.ts`). Two connectors: Coinbase
Wallet, which covers the extension, the phone app and a Smart Wallet passkey, so it is the only route
for someone with nothing installed; and injected, which arrives with its real name and icon when the
browser announces it over EIP-6963.

**One button.** `ConnectButton` in `src/Connect.tsx` is the only way to connect, on the app, the
portfolio and the owner desk alike. Someone with nothing installed has exactly one option and goes
straight to it; someone with an extension gets a small native `<dialog>` listing what they actually
have. It was two buttons side by side for a while, Coinbase and browser wallet, which asked a visitor
to know the difference before they had any reason to care.

Two faces onto the store, because most of this app is not a component. `src/wallet.ts` is imperative,
for the x402 payment stack, the sign-in flow and receipt recovery, all of which call
`signTypedData(address, payload)`. `src/Connect.tsx` is the hook version, for the pages that show who
is connected. Both read the same wagmi store, so there is one answer to "which wallet is this" no
matter who asks, the page re-renders when someone switches account in their wallet, and a reload
reconnects rather than forgetting.

wagmi, viem and react-query are about 68 kB gzipped and three pages have no wallet at all, so they
are loaded by `Wallets.tsx` only where one can be used.

The owner desk uses the same button but accepts one fixed address and verifies EOA signatures, so a
Smart Wallet address would be rejected after signing. Revisit alongside ERC-1271 verification.
