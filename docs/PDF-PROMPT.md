# Prompt for Claude Design: the Surplus explainer PDF

Paste everything below the line into Claude Design.

Two notes before you do. The document describes **Surplus complete**, not Surplus today, so it is
written in the present tense about a system that is still being built. The one safeguard against
that becoming dishonest is the framing line on the cover, which says so plainly. Keep it. With it,
every page can speak confidently about the finished product without a single caveat; without it, the
same pages are overstatement.

The second note is the instruction that matters most inside the prompt: **invent nothing.** A product
whose entire pitch is verification cannot have a made-up number in its own brochure.

---

Design and produce a PDF that explains **Surplus**, an autonomous research agent. Screen-first, 8 to
12 pages. Treat it as a product explainer for a technically literate reader: a hackathon judge, an
engineer, or an investor who will ask hard questions.

The document describes **the finished product**: Surplus as it is designed to work when complete.
Write every section in the present tense, as a description of the whole system. Do not hedge, do not
mark features as planned, and do not include a roadmap or a build-status page. The cover carries one
line establishing that this describes the complete design, and that single line does the work.

## Absolute rules

1. **Invent nothing.** Every number, quote, company name and mechanism must come from this brief. If
   a section feels thin, make it shorter rather than padding it. Do not estimate market sizes, user
   counts, revenue, growth, or competitor financials, and do not invent traction: no customers
   served, no briefs sold, no assets under management. Where a comparison needs a figure I have not
   given you, describe the mechanism in words instead.
2. **No em-dashes anywhere.** Use commas, colons or full stops.
3. **Describe the design, not adoption.** The finished product is a working system, not a popular
   one. Claims are about what it does and what it guarantees, never about how many people use it.
4. **One boundary is permanent and must be stated, not hidden:** Surplus never takes custody of a
   buyer's funds and never trades on a buyer's behalf. Buyers purchase a research document. The agent
   invests its own earnings, for its owner, under the owner's signature. This is a deliberate design
   choice in the finished product, not a limitation of an early version.
5. Include this line in the footer of every page: *Research is informational and is not investment
   advice. Filing text is quoted from SEC EDGAR.*

## Visual system, taken from the product's own UI

The PDF must look like it came from the same studio as the website. The site is dark and the PDF
should be too: it is made to be read on a screen, so say so on the cover rather than optimising for
paper.

**Colour** (use these exact values, no others):

| Role | Hex |
|---|---|
| Page ground | `#0F0F0F` |
| Raised panel | `#171717` |
| Chip or tag fill | `#202020` |
| Every rule and border | `#272727` |
| Headings and figures | `#FFFFFF` |
| Body text and labels | `#8D8D86` |
| Placeholders, struck-out text | `#5C5C58` |
| Accent | `#DAFA9C` |
| Ink on the accent | `#14180C` |
| Real money, caution | `#FFA05C` |
| Dropped, refused, failed | `#FF6B5B` |

**The accent is rationed.** Lime marks exactly two things: a verified fact, and the single most
important figure on a page. Never a heading, never a background wash, never decoration. If lime
appears more than twice on a page, remove one.

**Type:** Archivo for everything structural (headings, body, labels). DM Mono for every number,
ticker, hash, address, theme id and code-like token. That split is the one editorial rule of the
brand: prose in Archivo, evidence in DM Mono. Headings are medium weight with tight negative
tracking, around -0.04em at display size. Running prose sits at roughly 62 characters per line.
Figures are tabular.

**Layout:** nothing is centred. Every page uses a left spine of about 14 units holding a small
uppercase mono label (letter-spaced, `#8D8D86`), and a wider content column to its right. The reader
should be able to run their eye down one left edge through the whole document. Separate sections with
1px rules in `#272727`, not with cards. If you need to group content, use a bordered panel on
`#171717`, square corners or a 6px radius at most, no drop shadows, no gradients, no glows.

## Content

### 1. Cover
Title **Surplus**. One line under it: *An agent that sells research it can prove, and invests what it
earns.* Below that, in small mono: *This document describes the complete design of Surplus. Built for
Base Stocks Maxxing Season, Agentic Stock Finance.* Note that it is designed for screen reading.

### 2. What Surplus is, in one page
An autonomous agent with its own balance sheet. It sells cited stock research briefs for USDC over
the x402 protocol, books its own operating costs and a protected reserve, and invests a configured
share of the remaining surplus into Coinbase tokenized stocks on Base. Every trade carries the
owner's signature. Everything lands in a double-entry, append-only, reconcilable ledger.

Be explicit about who is who. **Buyers** purchase a research document and nothing else. The **owner**
is the only party whose capital the agent invests, under a mandate the agent cannot alter. No user
funds are held, pooled or traded.

Make the thesis land on this page: most agents spend someone else's money. This one **earns its own,
accounts for it, and has to answer for it.**

### 3. The need, and why anyone buys

Lead with the honest version of the product: **it sells public data, verified.** Then make the case
that this is a real market rather than a weakness.

The mechanism to explain: SEC filings are free and enormous. The scarce thing is not access, it is
the assurance that a claim about a filing is actually in that filing. Language models are fluent and
confidently wrong, so a summary of a filing is worth less than the filing itself unless something
guarantees the link back to the source. Surplus sells that guarantee.

Name the incumbents and what they sell, as proof the market exists. Describe their model in words,
with no invented figures:
- **Bloomberg, S&P Global, Morningstar, Moody's**: subscription terminals and research, sold on trust
  and coverage rather than on access to data that is largely public.
- **AlphaSense and Tegus**: search and expert transcripts over public and licensed filings.
- **Daloopa**: extracts figures from filings and guarantees they tie back to the source document.
  The closest analogue to what Surplus verifies.
- **Seeking Alpha, Zacks, Motley Fool**: retail research subscriptions.
- **Sell-side research** from the large banks, which European unbundling rules turned from a bundled
  giveaway into a separately priced product.

Then the wedge, stated as three differences and not as superiority:
1. **Verification is the product, not a feature.** A claim survives only if a 20 to 300 character
   quote appears verbatim in a filing it cites, and every number in the claim appears in those
   quotes. Anything that fails is dropped and reported.
2. **Failure is published.** When no company clears the evidence bar for a theme, the brief returns a
   gap with the reason rather than filler. A buyer learns what the agent could not establish, which
   no summary tool tells them.
3. **No account, no subscription, no sales call.** Payment is one signature in a wallet over x402, so
   a person or another agent can buy a single brief for cents. Every incumbent above requires a
   contract or a subscription. Surplus is priced and plumbed for a machine to be the customer.

### 4. How a brief is built
Four stages, in order, nothing skips one: **Filings → Quotes → Fits → Gaps.**
- Sources are SEC EDGAR 10-K and 10-Q documents, tier 1. A fact needs a tier 1 to 3 source, or two
  independent tier 4 publishers.
- A fact survives only on the verbatim quote rule above.
- A company reaches a theme only through a surviving fact from its own filing, and when a theme
  carries keywords, a supporting quote must mention the theme.
- Evidence score is 1 plus supporting facts, capped at 5. Only fits scoring 3 or more receive money.
- Source documents are treated as untrusted input. Instructions found inside a filing are never
  followed, and a buyer's own submitted themes are treated the same way.
- The model never computes money, never sets a source tier, and never sets an evidence score.

Use a real example, verbatim:
> Claim: Tesla invests in compute infrastructure and data centers as part of its AI initiatives.
> Quote: "we currently expect our capital expenditures to be in excess of $20 billion in 2026, driven
> by our AI initiatives, including investments in compute infrastructure and data centers"
> Source: Tesla, Inc. 10-K for period ending 2025-12-31, filed 2026-01-29, SEC EDGAR

And two real rejections, to show the bar bites: a claim dropped because its quote ran to 343
characters, past the excerpt limit; and a claim dropped because the advertising language the model
quoted was not present in the document it cited. Set these in the red `#FF6B5B`, struck through.

### 5. The full money loop
A numbered rail, left aligned: **sell → book costs → fill reserve → compute surplus → allocate →
propose → owner signs → execute → reconcile → exit.**

Rules worth stating because they are unusual:
- Money is integer USDC minor units. No floats anywhere. Round down when allocating, round up when
  booking a cost.
- The ledger is double-entry, append-only, idempotent and chronological, and every entry is tagged
  with the network it belongs to. Revenue cannot cross networks and simulated activity never enters
  a real book.
- The mandate is versioned and hash-chained. The agent cannot change the owner's constraints, and an
  altered or truncated mandate file stops the system from starting.
- An approval binds the proposal hash, the mandate version and hash, a maximum spend and an expiry.
  If the price moves past tolerance while the owner reads the evidence, the signature stops being
  valid and the agent asks again.
- Pre-trade gates: the token must be on Base's official registry and the Coinbase tokenized stock
  API, carry no paused flags, clear a liquidity floor, and quote inside a freshness window. Quotes
  come from an aggregator with the router pinned; net asset value is a reference, never a price.
- A fill is booked from what the swap actually returned, never from the quote. A trade is simulated,
  signed, journalled, and only then broadcast, so a crash can always be resolved against the chain.
- Positions are reconciled against onchain balances. If the books claim tokens the wallet does not
  hold, that is a failure, loudly.
- The agent exits as well as enters, within the same mandate and the same signature discipline.
- Unplaceable money stays uninvested with a stated reason, such as `below_minimum` or `company_cap`.
  Nothing is forced into a trade to look busy.

### 6. Skin in the game
The page that joins the two halves. Each brief shows which positions the agent itself holds against
that research, bought with its own earnings, with the signed approval and the onchain transaction
behind them. The agent pays a price for being wrong, and the reader can check it. No newsletter, no
terminal and no chatbot offers that.

### 7. The economics
Present this as the engine, not as a footnote.

| | |
|---|---|
| Cost to generate one brief | `$0.021087` measured on `gemini-3.1-flash-lite` |
| Work per brief | about 70,600 input and 2,300 output tokens, across 3 model calls |

Two price structures, because there are two products:
- A **catalogue brief** is generated once and sold many times, so its cost is amortized across sales.
- A **commissioned brief** is generated per request against the buyer's own themes, so its cost is
  marginal. A hard cap guarantees a generated brief can never cost more than the buyer paid for it.

State the pricing rule plainly: **a catalogue brief is priced at roughly four times the generation
cost of the model in production.** One sale pays for the brief outright, so producing research never
puts the agent behind, and the sales after it fund the reserve and the first investment. The reserve
itself is expressed as runway, enough to generate a known number of further briefs, so it tracks the
real cost of operating rather than being a figure someone picked.

Close the page with the consequence: the agent's research funds the agent's investing. Nobody tops it
up.

### 8. What Surplus deliberately does not do
A short page of boundaries, stated as design, because a reader will ask.
- It does not hold, pool or custody anyone's funds.
- It does not trade on a buyer's behalf or give personalized advice.
- It does not act on instructions found inside the documents it reads.
- It does not invent a finding to fill a theme, and does not hide the ones it dropped.
- It does not let a model touch money, source tiers or evidence scores.
- It does not move a cent without the owner's signature on that exact trade.

### 9. Closing page
One sentence, set large, lime on near-black, nothing else on the page:
**It only sells what it can prove.**
