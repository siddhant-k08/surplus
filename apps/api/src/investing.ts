import {
    Treasury,
    flushNewEntries,
    allocate,
    toCandidates,
    validateBrief,
    swapPlan,
    swapPlanTotal,
    orderShares,
    exitPlan,
    positionsFromLedger,
    themeDrift,
    themeHoldings,
    themeKey,
    realizedSales,
    investmentGap,
    preTradeChecks,
    blockReasons,
    warnings,
    proposalHash,
    serializeProposal,
    parseProposal,
    type ProposalStore,
    approvalTypedDataJson,
    formatUsdc,
    type InvestmentGap,
    type RealizedFill,
    type Quote,
    type SwapOrder,
    type LedgerTx,
    type Leg,
    type Approval,
    type Ledger,
    type LedgerSink,
    type MandateStore,
    type LegQuotes,
    type SavedBrief,
    type TokenRecord,
    type Mode,
    type ExitCandidate,
    type Skipped,
    type Drift,
    type Position,
} from "@surplus/core";
import type { ExecutionRecord } from "./journal";
import { log, errorFields } from "./log";

/** Everything the engine needs from the outside world, injected so tests need no network. */
export interface MarketData {
    /** Tokens that are both in Base's registry and the Coinbase API right now. */
    trusted: readonly TokenRecord[];
    /** Liquidity score per lowercase address. */
    liquidity: ReadonlyMap<string, number>;
    /** Live quotes for the given legs. */
    quote: (legs: readonly Leg[]) => Promise<LegQuotes>;
}

/** Verifies that an approval carries the owner's signature. Injected so tests can drive a real signer. */
export type ApprovalVerifier = (args: { approval: Approval; signature: string }) => Promise<
    { ok: true; signer: string } | { ok: false; reason: string }
>;

export interface InvestingDeps {
    /** `sim` while fills are simulated. Only ever `mainnet` with explicit authorization. */
    mode: Mode;
    /**
     * Working capital the owner put in, booked once against `equity.opening`.
     *
     * Without it the books report an impossible state: the model cost is real money that was spent before
     * any revenue arrived, so operating cash goes negative and `reconcileInternal` rightly objects. The
     * money came from the owner, and recording that is more accurate than leaving it out.
     */
    openingFloat?: bigint;
    /** The owner's mandate, shared with the server so both see the same version. */
    mandates: MandateStore;
    /**
     * The newest brief in the owner's catalogue.
     *
     * Allowed to return a promise: a brief may be stored in a database. A plain value is accepted too, so
     * a test can hand over a fixture without ceremony.
     */
    readBrief: () => SavedBrief | Promise<SavedBrief>;
    /** Every brief the agent has produced, so each one's model cost is booked exactly once. */
    allBriefs: () => readonly SavedBrief[] | Promise<readonly SavedBrief[]>;
    /**
     * Brief files that could not be read. Reported by `syncRevenue` because each one is a model cost
     * missing from the ledger, which understates what the agent actually spent.
     */
    briefProblems?: () =>
        | readonly { file: string; error: string }[]
        | Promise<readonly { file: string; error: string }[]>;
    /**
     * Sends the swaps, when there are real ones to send.
     *
     * Absent means fills are simulated, which is the normal state: the executor refuses to exist
     * without mainnet deliberately enabled, a spend cap and a key.
     */
    executor?: {
        fill(order: SwapOrder, quote: Quote, key: string): Promise<{ amountOut: bigint; transaction: string }>;
        /** Asks the chain what became of anything signed whose outcome is unknown. */
        recover?(): Promise<unknown>;
        /** The journal of what was sent, which is how a swap missing from the books is found. */
        records?(): Promise<{ filled: ExecutionRecord[]; unresolved: ExecutionRecord[] }>;
    };
    /** The paid endpoint's ledger, read only, as the source of real revenue. */
    salesLedger: () => readonly LedgerTx[];
    market: () => Promise<MarketData>;
    /** Already loaded, because storage is async and a constructor is not. */
    ledger?: Ledger;
    /** Where new entries go. Absent means nothing is persisted. */
    sink?: LedgerSink;
    /** Where proposals are kept between requests. Absent means they live and die with this engine. */
    proposals?: ProposalStore;
    now?: () => Date;
    /** Required to approve anything. Without it the engine refuses every approval. */
    verifyApproval?: ApprovalVerifier;
    /** Chain id bound into the signed domain, so a testnet signature is not valid elsewhere. */
    chainId: number;
}

/** Brief id used when a sale predates per-sale attribution and does not name its brief. */
export const UNATTRIBUTED = "unattributed";

/**
 * How long an approved proposal's swaps are left alone before they are booked from the journal. Longer
 * than a request can live on the host, so a proposal still being executed is never booked twice over.
 */
const STILL_EXECUTING_MS = 120_000;

export interface Reconciliation {
    /** Swaps that had happened and were not in the books until now. */
    recovered: { proposalId: string; symbol: string; transaction: string }[];
    /** Why some swap is still not in the books. While this is not empty nothing new is proposed. */
    outstanding: string[];
}

export interface SyncResult extends Reconciliation {
    sales: number;
    /** Brief files that could not be read, so their cost is not in the books. */
    unreadableBriefs: { file: string; error: string }[];
    /** Sales whose ledger entry carries no brief id, so their revenue cannot be tied to a brief. */
    unattributedSales: number;
    /**
     * Sales that were not mirrored because they were earned on another network.
     *
     * Real but not spendable here: a mainnet book funded by testnet revenue would be the agent
     * spending real money while claiming to have earned it.
     */
    refusedSales: { transaction: string; mode: string; amountUsdcMinor: string }[];
    briefsCosted: number;
    revenue: bigint;
    costs: bigint;
    investable: bigint;
    settled: { briefId: string; investable: bigint }[];
    /** How far the agent is from being able to place its smallest allowed trade. */
    gap: InvestmentGap;
}

export interface ProposalView {
    id: string;
    state: string;
    hash: string;
    mandateVersion: number;
    mandateHash: string;
    totalUsdcIn: string;
    legs: { symbol: string; asset: string; theme: string; usdcIn: string }[];
    swaps: { symbol: string; usdcIn: string; parts: { theme: string; usdcIn: string }[] }[];
    createdAt: string;
}

/**
 * The owner-facing investing loop: mirror revenue, settle, allocate, propose, approve, execute.
 *
 * It keeps its own ledger, separate from the paid endpoint's. The endpoint's book records real money
 * received onchain; this book records what the agent decided to do with the surplus, and while fills are
 * simulated its entries are tagged `sim`. A simulated fill must never land in the real book.
 */
export class InvestingEngine {
    readonly treasury: Treasury;
    readonly mandates: MandateStore;
    private readonly now: () => Date;
    private persistedId = 0;
    /** Settlement transactions already mirrored into this book, so a sale is never counted twice. */
    private readonly mirrored = new Set<string>();
    private readonly proposalIds = new Set<string>();
    /** The exact approval the owner was asked to sign, per proposal. */
    private readonly offered = new Map<string, Approval>();

    constructor(private readonly deps: InvestingDeps) {
        this.now = deps.now ?? (() => new Date());
        this.mandates = deps.mandates;
        const ledger = deps.ledger;
        this.treasury = new Treasury({
            mode: deps.mode,
            mandates: this.mandates,
            now: this.now,
            ...(ledger && { ledger }),
        });
        this.persistedId = ledger?.all().at(-1)?.id ?? 0;

        // Which sales this book has already mirrored, read back from the entries themselves. A legacy
        // entry that lumped several sales into one total carries no transaction, so which sales it covered
        // cannot be known: refuse rather than guess, since guessing would double count or lose revenue.
        for (const tx of this.treasury.ledger.all()) {
            if (tx.type !== "PAYMENT_RECEIVED") continue;
            if (tx.txHash !== undefined) {
                this.mirrored.add(tx.txHash.toLowerCase());
                continue;
            }
            if (tx.idempotencyKey?.startsWith("pay:mirror:") === true) {
                throw new Error(
                    `This investing book holds a lumped revenue entry (${tx.idempotencyKey}) from before revenue was ` +
                    "attributed per sale, and which sales it covered cannot be recovered. The book is simulated and " +
                    "rebuilds from the sales ledger and the saved briefs, so delete it and let it regenerate.",
                );
            }
        }

        // Working capital is a running total, not a per-amount entry. Keying on the amount meant that
        // changing the configured float added a second entry instead of adjusting, silently inflating
        // recorded equity. Only the difference is booked, and a reduction is refused: taking capital back
        // out is an owner decision that needs its own deliberate entry, not a quiet config edit.
        const wanted = deps.openingFloat ?? 0n;
        if (wanted < 0n) throw new Error("openingFloat must not be negative");
        const booked = -this.treasury.ledger.balance("equity.opening");
        if (wanted < booked) {
            throw new Error(
                `openingFloat is ${wanted} but ${booked} of working capital is already booked. ` +
                "Reducing it would rewrite history; book a withdrawal instead or reset the simulated book.",
            );
        }
        const topUp = wanted - booked;
        if (topUp > 0n) {
            this.treasury.ledger.post({
                type: "OPENING_BALANCE",
                mode: deps.mode,
                at: this.now(),
                idempotencyKey: `opening:total:${wanted.toString()}`,
                memo: deps.mode === "mainnet"
                    ? "owner-provided working capital"
                    : "owner-provided working capital (simulated)",
                lines: [
                    { account: "cash.operating", amount: topUp },
                    { account: "equity.opening", amount: -topUp },
                ],
            });
            void this.flush();
        }
    }

    /**
     * What the agent has earned and spent over its whole life, from its own book.
     *
     * Per-brief settlement can hand one profitable brief some surplus while the business overall is
     * behind, so the lifetime position is a separate question from any brief's.
     */
    lifetime(): { revenue: bigint; costs: bigint; behindBy: bigint } {
        const ledger = this.treasury.ledger;
        const revenue = -ledger.balance("revenue.research");
        const costs =
            ledger.balance("expense.llm") + ledger.balance("expense.search") + ledger.balance("expense.gas");
        const behindBy = costs > revenue ? costs - revenue : 0n;
        return { revenue, costs, behindBy };
    }

    /** Exposure per asset so far, in the USDC that bought it, read from the positions accounts. */
    heldByAsset(): Map<string, bigint> {
        const out = new Map<string, bigint>();
        for (const [account, amount] of this.treasury.ledger.balances()) {
            if (!account.startsWith("positions.")) continue;
            if (amount === 0n) continue;
            out.set(account.slice("positions.".length).toLowerCase(), amount);
        }
        return out;
    }

    /**
     * Writes new entries to storage.
     *
     * Returns a promise the callers await. Storage is async now that it can be a database, and a flush
     * that is not awaited would let a response claim money was booked before it was durable.
     */
    private async flush(): Promise<void> {
        const sink = this.deps.sink;
        if (sink === undefined) return;
        this.persistedId = await flushNewEntries(this.treasury.ledger, sink, this.persistedId);
    }

    /**
     * Books any revenue the paid endpoint has taken that this book has not seen, plus the brief's metered
     * model cost, then settles. Idempotent: mirroring twice books nothing the second time.
     *
     * Revenue is mirrored as a total rather than per sale so the entry can name the transactions it stands
     * for. The real money and its onchain proof stay in the endpoint's own ledger.
     */
    async syncRevenue(): Promise<SyncResult> {
        const reconciled = await this.reconcileSwaps();

        // Every brief the agent produced cost real money, whether or not anyone bought it. Booking only
        // the newest one understated spending as soon as a second brief existed.
        const briefs = await this.deps.allBriefs();
        let costs = 0n;
        for (const saved of briefs) {
            this.treasury.accrueCost({
                id: `llm-${saved.brief.id}`,
                briefId: saved.brief.id,
                kind: "llm",
                amount: saved.costUsdcMinor,
                memo: "metered estimate at paid-tier rates",
            });
            costs += saved.costUsdcMinor;
        }

        // Revenue follows the brief that was actually sold, which the sales ledger records per payment.
        const sales = realizedSales(this.deps.salesLedger());
        const earners = new Set<string>();
        let revenue = 0n;
        let unattributed = 0;
        const refusedSales: { transaction: string; mode: string; amountUsdcMinor: string }[] = [];
        for (const sale of sales) {
            // Money earned on one network cannot fund trades on another.
            //
            // Selling runs on Base Sepolia because that is the only network the free facilitator serves,
            // and the tokenized stocks exist only on Base mainnet. Mirroring testnet revenue into a
            // mainnet book would have the agent spend real money while its books claimed it had earned
            // it. Whatever a mainnet book invests is the owner's capital until selling moves to mainnet
            // too, and the opening float is where that is recorded and labelled.
            if (this.deps.mode === "mainnet" && sale.mode !== "mainnet") {
                refusedSales.push({
                    transaction: sale.transaction,
                    mode: sale.mode,
                    amountUsdcMinor: sale.amountUsdcMinor.toString(),
                });
                continue;
            }
            revenue += sale.amountUsdcMinor;
            const briefId = sale.briefId ?? UNATTRIBUTED;
            if (sale.briefId === undefined) unattributed += 1;
            earners.add(briefId);
            const tx = sale.transaction.toLowerCase();
            if (this.mirrored.has(tx)) continue;
            this.treasury.receivePayment({
                id: `mirror:${tx}`,
                briefId,
                amount: sale.amountUsdcMinor,
                txHash: sale.transaction,
                memo: `mirrors real sale ${sale.transaction.slice(0, 10)} of ${briefId}`,
            });
            this.mirrored.add(tx);
        }

        // Settle every brief that earned something. Each one sees the reserve as it stands, so the first
        // fills the reserve gap and later ones go to surplus, which is the correct order of priority.
        const settled: { briefId: string; investable: bigint }[] = [];
        let investable = 0n;
        for (const briefId of [...earners].sort()) {
            const r = this.treasury.settleBrief(briefId);
            settled.push({ briefId, investable: r.investable });
            investable += r.investable;
        }

        await this.flush();
        return {
            ...reconciled,
            gap: this.gap(),
            sales: sales.length - refusedSales.length,
            refusedSales,
            unreadableBriefs: [...(await (this.deps.briefProblems?.() ?? []))],
            unattributedSales: unattributed,
            briefsCosted: briefs.length,
            revenue,
            costs,
            investable: this.treasury.ledger.balance("surplus.investable"),
            settled,
        };
    }

    /**
     * How far the books are from allowing a trade, by the same rules settlement uses.
     *
     * "Nothing to invest" is the agent behaving correctly, but on its own it does not say whether that
     * is one sale away or a hundred. This is the number.
     */
    gap(): InvestmentGap {
        const terms = this.deps.mandates.current().terms;
        const ledger = this.treasury.ledger;
        return investmentGap({
            revenue: ledger.balance("revenue.research") < 0n ? -ledger.balance("revenue.research") : 0n,
            costs: ledger.balance("expense.llm"),
            reserveBalance: ledger.balance("reserve"),
            reserveTarget: terms.reserveTargetUsdc,
            investShareBps: terms.investShareBps,
            minTrade: terms.minTradeUsdc,
            investable: ledger.balance("surplus.investable"),
        });
    }

    /** Writes down where a proposal has got to, so the next request can be served by any process. */
    private async save(id: string): Promise<void> {
        if (this.deps.proposals === undefined) return;
        const offered = this.offered.get(id);
        await this.deps.proposals.save(id, serializeProposal({
            ...this.treasury.exportProposal(id),
            ...(offered !== undefined && { offered }),
        }));
    }

    /** Reads a proposal back. Storage wins over memory: another process may have moved it on. */
    private async load(id: string): Promise<void> {
        const document = await this.deps.proposals?.load(id);
        if (document === undefined || document === null) return;
        const stored = parseProposal(document, `proposal ${id}`);
        this.treasury.restoreProposal(stored);
        this.proposalIds.add(id);
        if (stored.offered === undefined) this.offered.delete(id);
        else this.offered.set(id, stored.offered);
    }

    /** An id used twice would overwrite one proposal and silently drop the other's fills as duplicates. */
    private async refuseReusedId(id: string): Promise<void> {
        if (await this.deps.proposals?.load(id)) throw new Error(`Proposal ${id} already exists`);
    }

    /**
     * Builds a proposal from the newest brief and live quotes. Never approves it: approval is the owner's
     * separate decision.
     */
    async propose(id: string): Promise<
        | { ok: true; view: ProposalView; toSign: unknown; warnings: string[] }
        | { ok: false; reasons: string[] }
    > {
        // A swap not yet in the books has spent money the books still show as available. Proposing over
        // it would spend the same surplus twice.
        const { outstanding } = await this.reconcileSwaps();
        if (outstanding.length > 0) return { ok: false, reasons: outstanding };

        const saved = await this.deps.readBrief();
        const market = await this.deps.market();
        const eligible = new Set(market.trusted.map((t) => t.address.toLowerCase()));

        // A brief may cover far more companies than the agent may trade, so its shape is checked against
        // what it names and the trusted set is applied to the candidates below.
        const named = new Set(saved.brief.themes.flatMap((t) => t.fits.map((f) => f.asset.toLowerCase())));
        const issues = validateBrief(saved.brief, { eligible: named });
        if (issues.length > 0) {
            return { ok: false, reasons: issues.map((i) => `${i.path} ${i.rule}: ${i.message}`) };
        }

        const investable = this.treasury.ledger.balance("surplus.investable");
        if (investable <= 0n) {
            return { ok: false, reasons: ["nothing investable; sync revenue first or sell more briefs"] };
        }

        // An owner can forbid investing while the agent is behind over its life. Without it a single
        // profitable brief could fund trades out of a float that the rest of the work has been eating.
        const terms = this.mandates.current().terms;
        if (terms.investOnlyWhenAhead === true) {
            const { revenue, costs, behindBy } = this.lifetime();
            if (behindBy > 0n) {
                return {
                    ok: false,
                    reasons: [
                        `the mandate forbids investing while behind: earned ${formatUsdc(revenue)}, ` +
                        `spent ${formatUsdc(costs)}, behind by ${formatUsdc(behindBy)} USDC`,
                    ],
                };
            }
        }

        // Only themes the mandate actually targets can be funded. A brief can legitimately carry others
        // (a custom request, or a theme the owner has since dropped); the allocator throws on those, so
        // they are filtered out here and reported rather than taking the whole proposal down.
        const funded = new Set(this.mandates.current().terms.themes.map((t) => t.id));
        const unfunded = saved.brief.themes.filter((t) => !funded.has(t.themeId)).map((t) => t.themeId);
        const themes = saved.brief.themes
            .filter((t) => funded.has(t.themeId))
            .map((t) => ({
                id: t.themeId,
                candidates: toCandidates(
                    t.fits.filter((f) => eligible.has(f.asset.toLowerCase())), market.liquidity, 3, 1,
                ),
            }));
        const researchOnly = [...new Set(
            saved.brief.themes
                .filter((t) => funded.has(t.themeId))
                .flatMap((t) => t.fits)
                .filter((f) => !eligible.has(f.asset.toLowerCase()))
                .map((f) => f.symbol),
        )];
        if (themes.length === 0) {
            return {
                ok: false,
                reasons: [
                    `brief ${saved.brief.id} has no theme the mandate funds` +
                    (unfunded.length > 0 ? ` (it covers ${unfunded.join(", ")})` : ""),
                ],
            };
        }
        // Count what is already held so the company cap limits total exposure, not just this proposal.
        const held = this.heldByAsset();
        const alloc = allocate({ investable, themes, terms: this.mandates.current().terms, held });
        if (alloc.legs.length === 0) {
            return {
                ok: false,
                reasons: alloc.uninvested.map((x) => `${x.theme ?? "no theme"}: ${formatUsdc(x.amount)} uninvested (${x.reason})`),
            };
        }

        await this.refuseReusedId(id);
        const quoted = await market.quote(alloc.legs);
        // The brief goes on the proposal so every fill it books can be traced back to the research that
        // argued for it, which is what `backing` reads and what the buyer sees on their own brief.
        const created = this.treasury.createProposal({
            id,
            legs: alloc.legs,
            quotedPrices: quoted.prices,
            held,
            briefId: saved.brief.id,
        });
        this.proposalIds.add(id);
        await this.flush();
        if (!created.ok) return { ok: false, reasons: created.reasons };

        // Offer the owner the exact approval to sign, with an expiry this server chose. Recomputing it at
        // approval time would drift by the round trip and the signature would never match.
        const mandate = this.mandates.current();
        const rec = this.treasury.proposal(id);
        const total = rec.proposal.legs.reduce((a, l) => a + l.usdcIn, 0n);
        const approval: Approval = {
            proposalHash: proposalHash(rec.proposal, mandate.hash),
            mandateVersion: mandate.version,
            mandateHash: mandate.hash,
            maxUsdcIn: total,
            expiresAt: new Date(this.now().getTime() + mandate.terms.approvalExpirySeconds * 1000).toISOString(),
        };
        this.offered.set(id, approval);
        await this.save(id);

        return {
            ok: true,
            view: this.view(id),
            toSign: approvalTypedDataJson(approval, this.deps.chainId),
            warnings: [
                ...[...quoted.errors].map(([asset, why]) => `no quote for ${asset}: ${why}`),
                ...unfunded.map((t) => `theme ${t} is in the brief but not funded by the mandate, so it was skipped`),
                ...(researchOnly.length === 0
                    ? []
                    : [`research only, not tradable, so left out: ${researchOnly.join(", ")}`]),
            ],
        };
    }

    /**
     * Builds a proposal to sell, from the mandate's exit rules or from a request the owner made by name.
     *
     * Deliberately the same machinery as `propose` from here on: one proposal, one policy check, one
     * EIP-712 signature, one drift gate at execution. An exit that bypassed any of those would be the
     * one trade the owner did not authorise, and selling is no less consequential than buying.
     *
     * The themes come from where the money went in, read off the fills themselves, so a sale is
     * attributed to the research that argued for the position rather than to whatever theme is current.
     */
    /**
     * Sell-side quotes for everything held, token in and USDC out, sized by the units held.
     *
     * One quote per token rather than per theme: the price of a token does not depend on why it is
     * held. Shared by `exit` and `drift` so the two can never price the same portfolio differently,
     * which would let the desk show a drift the proposal did not act on.
     */
    private async sellQuotes(
        market: MarketData,
        open: ReadonlyMap<string, Position>,
        maxSlippageBps: number,
    ): Promise<{
        prices: ReadonlyMap<string, bigint>;
        /** Tokens that could not be quoted, which a caller reporting to a person has to say out loud. */
        errors: ReadonlyMap<string, string>;
        decimals: Map<string, number>;
        symbols: Map<string, string>;
    }> {
        const decimals = new Map(market.trusted.map((t) => [t.address, t.decimals]));
        const symbols = new Map(market.trusted.map((t) => [t.address, t.symbol]));
        const quoted = await market.quote(
            [...open].map(([asset, p]) => ({
                asset,
                symbol: symbols.get(asset) ?? asset,
                theme: this.themeOf(asset),
                usdcIn: p.costUsdcIn,
                maxSlippageBps,
                side: "sell" as const,
                unitsIn: p.units,
            })),
        );
        return { prices: quoted.prices, errors: quoted.errors, decimals, symbols };
    }

    /**
     * Where the themes sit against their targets, proposing nothing.
     *
     * The same measurement `exit` makes, without the refusals that belong to selling. An owner
     * choosing a rebalance band has to be able to see the drift *before* the mandate carries the rule,
     * so this must not require one: a reading that only appears once you have already set the number
     * is no help in setting it.
     */
    async drift(): Promise<Drift> {
        const positions = positionsFromLedger(this.treasury.ledger.all());
        const open = new Map([...positions].filter(([, p]) => p.units > 0n || p.costUsdcIn > 0n));
        if (open.size === 0) return { themes: [], totalUsdc: 0n, untargetedUsdc: 0n };

        const terms = this.mandates.current().terms;
        const market = await this.deps.market();
        const { prices, decimals } = await this.sellQuotes(market, open, terms.maxSlippageBps);
        return themeDrift({
            holdings: themeHoldings(this.treasury.ledger.all()),
            prices,
            decimals,
            terms,
        });
    }

    async exit(
        id: string,
        requested?: readonly { asset: string; units?: bigint }[],
    ): Promise<
        | {
            ok: true; view: ProposalView; toSign: unknown; warnings: string[];
            candidates: ExitCandidate[]; skipped: Skipped[]; drift: Drift;
        }
        | { ok: false; reasons: string[]; skipped?: Skipped[]; drift?: Drift }
    > {
        const { outstanding } = await this.reconcileSwaps();
        if (outstanding.length > 0) return { ok: false, reasons: outstanding };

        const market = await this.deps.market();
        const positions = positionsFromLedger(this.treasury.ledger.all());
        const open = new Map([...positions].filter(([, p]) => p.units > 0n || p.costUsdcIn > 0n));
        if (open.size === 0) {
            return { ok: false, reasons: ["the agent holds nothing, so there is nothing to sell"] };
        }

        const terms = this.mandates.current().terms;
        const noRule =
            terms.takeProfitBps === undefined &&
            terms.stopLossBps === undefined &&
            terms.rebalanceBandBps === undefined;
        if (noRule && (requested ?? []).length === 0) {
            return {
                ok: false,
                reasons: [
                    "the mandate states no exit rule and no sale was requested; " +
                    "set takeProfitBps, stopLossBps or rebalanceBandBps, or name what to sell",
                ],
            };
        }

        const { prices, errors, decimals, symbols } = await this.sellQuotes(market, open, terms.maxSlippageBps);

        // The same money split by theme, which is what a sale actually leaves and what a trim measures.
        const holdings = themeHoldings(this.treasury.ledger.all());
        const plan = exitPlan({
            positions: open,
            holdings,
            prices,
            decimals,
            symbols,
            terms,
            ...(requested !== undefined && { requested }),
        });
        if (plan.legs.length === 0) {
            return {
                ok: false,
                reasons: plan.skipped.length > 0
                    ? plan.skipped.map((s) => `${s.symbol}: ${s.why}`)
                    : ["no position meets the mandate's exit rules right now"],
                skipped: plan.skipped,
                drift: plan.drift,
            };
        }

        await this.refuseReusedId(id);
        const created = this.treasury.createProposal({ id, legs: plan.legs, quotedPrices: prices });
        this.proposalIds.add(id);
        await this.flush();
        if (!created.ok) return { ok: false, reasons: created.reasons, skipped: plan.skipped };

        const mandate = this.mandates.current();
        const rec = this.treasury.proposal(id);
        const approval: Approval = {
            proposalHash: proposalHash(rec.proposal, mandate.hash),
            mandateVersion: mandate.version,
            mandateHash: mandate.hash,
            // On a sale this bounds the notional being disposed of rather than money being spent. The
            // proposal hash is what binds the exact units, so the owner signs an exact basket either way.
            maxUsdcIn: rec.proposal.legs.reduce((a, l) => a + l.usdcIn, 0n),
            expiresAt: new Date(this.now().getTime() + mandate.terms.approvalExpirySeconds * 1000).toISOString(),
        };
        this.offered.set(id, approval);
        await this.save(id);

        return {
            ok: true,
            view: this.view(id),
            toSign: approvalTypedDataJson(approval, this.deps.chainId),
            candidates: plan.candidates,
            skipped: plan.skipped,
            drift: plan.drift,
            warnings: [
                ...[...errors].map(([asset, why]) => `no quote for ${asset}: ${why}`),
                ...plan.skipped.map((x) => `${x.symbol} not sold: ${x.why}`),
                // A caveat is a warning, not a footnote: it changes what the number beside it means.
                ...plan.candidates.flatMap((c) => (c.caveat === undefined ? [] : [`${c.symbol}: ${c.caveat}`])),
            ],
        };
    }

    /**
     * The theme a position is mostly held under, for the one place that needs a single answer: the
     * quote request, which is per token and does not care why the token is held.
     *
     * Sales themselves are no longer attributed this way. Each one is scoped to its own theme, which
     * `themeHoldings` knows exactly, because a token held under two themes is two holdings and taking
     * the larger would misattribute the smaller.
     */
    private themeOf(asset: string): string {
        const totals = new Map<string, bigint>();
        for (const tx of this.treasury.ledger.all()) {
            if (tx.type !== "PURCHASE_SETTLED" || tx.theme === undefined) continue;
            const line = tx.lines.find((l) => l.account === `positions.${asset}`);
            if (line === undefined) continue;
            totals.set(tx.theme, (totals.get(tx.theme) ?? 0n) + line.amount);
        }
        let best: string | null = null;
        for (const [theme, total] of totals) {
            if (best === null || total > totals.get(best)!) best = theme;
        }
        return themeKey(best);
    }

    /**
     * Records an approval, but only against the owner's signature over the payload this server offered.
     *
     * There is no unsigned path. The bearer token on the route only decides who may reach it; the signature
     * is what authorizes this particular spend, so holding the token is not enough to approve a trade.
     */
    async approve(
        id: string,
        signature: string,
    ): Promise<{ ok: true; expiresAt: string; signer: string } | { ok: false; reasons: string[] }> {
        const verify = this.deps.verifyApproval;
        if (verify === undefined) {
            return { ok: false, reasons: ["this server cannot verify owner signatures, so it cannot approve"] };
        }
        await this.load(id);
        const approval = this.offered.get(id);
        if (approval === undefined) {
            return { ok: false, reasons: [`no approval payload was offered for ${id}; propose it first`] };
        }

        // The signature covers a mandate version and hash. If the mandate has moved since the offer, the
        // owner authorized constraints that are no longer in force, so the signature must not be usable.
        const mandate = this.mandates.current();
        if (approval.mandateVersion !== mandate.version || approval.mandateHash !== mandate.hash) {
            this.offered.delete(id);
            await this.save(id);
            return {
                ok: false,
                reasons: [
                    `the mandate changed since this was offered (authorized v${approval.mandateVersion}, ` +
                    `current v${mandate.version}); propose again and sign the new payload`,
                ],
            };
        }

        const verdict = await verify({ approval, signature });
        if (!verdict.ok) return { ok: false, reasons: [verdict.reason] };

        const result = this.treasury.approve(id, verdict.signer, {
            expiresAt: approval.expiresAt,
            signature,
            expect: approval,
        });
        await this.flush();
        await this.save(id);
        if (!result.ok) return { ok: false, reasons: result.reasons };
        return { ok: true, expiresAt: result.approval.expiresAt, signer: verdict.signer };
    }

    /**
     * Re-quotes, runs the pre-trade gates, and executes only if nothing blocks.
     *
     * Fills are simulated while the mode is `sim`; the ledger memo and mode tag say so. A block, stale
     * quote or price drift stops execution and the proposal needs re-approval.
     */
    async execute(id: string): Promise<
        | {
            ok: true;
            fills: {
                symbol: string; usdcIn: string; price: string; quantity: string;
                side?: "sell"; proceedsUsdc?: string; realizedUsdc?: string;
            }[];
            /** Legs whose swap did not execute. Not booked, and the proposal is not settled. */
            unfilled: { symbol: string; usdcIn: string; reason: string }[];
            simulated: boolean;
            warnings: string[];
        }
        | { ok: false; reasons: string[]; outcome?: string }
    > {
        // Not this proposal's own swaps: running it again resumes those and books them below.
        const { outstanding } = await this.reconcileSwaps(id);
        if (outstanding.length > 0) return { ok: false, reasons: outstanding };

        await this.load(id);
        const rec = this.treasury.proposal(id);
        const market = await this.deps.market();
        const fresh = await market.quote(rec.proposal.legs);
        const decimals = new Map(market.trusted.map((t) => [t.address, t.decimals]));
        const tokens = new Map(market.trusted.map((t) => [t.address, t]));

        const gates = preTradeChecks({
            legs: rec.proposal.legs,
            quotes: fresh.quotes,
            tokens,
            liquidity: market.liquidity,
            now: this.now(),
        });
        const blocks = blockReasons(gates);

        // Real swaps, when there are any to send. Anything the gates stopped is not sent at all: the
        // checks exist to be read before the money moves, not after.
        const live = this.deps.executor !== undefined && this.deps.mode === "mainnet" && blocks.length === 0;
        // Signature, expiry, drift and mandate are all settled before anything is broadcast. A proposal
        // that was never approved throws here, with nothing sent.
        const checkedAt = this.now();
        const sending = live && this.treasury.preflight(id, fresh.prices, checkedAt).length === 0;
        const { realized, problems } = sending
            ? await this.sendSwaps(id, rec.proposal.legs, fresh.quotes)
            : { realized: undefined, problems: [] as string[] };

        let result;
        try {
            result = this.treasury.execute(id, {
                freshPrices: fresh.prices,
                decimals,
                blocks,
                ...(sending && { checkedAt }),
                ...(realized !== undefined && { realized }),
            });
        } finally {
            // Saved however it ended. Books first, so a proposal never reads as settled ahead of them.
            await this.flush();
            if (this.treasury.state(id) !== "APPROVED") await this.save(id);
        }

        if (!result.ok) return { ok: false, reasons: result.reasons, outcome: result.outcome };
        return {
            ok: true,
            simulated: !sending,
            warnings: [...warnings(gates), ...problems],
            unfilled: result.unfilled.map((x) => ({ symbol: x.symbol, usdcIn: x.usdcIn.toString(), reason: x.reason })),
            fills: result.fills.map((f) => ({
                symbol: f.symbol,
                usdcIn: f.usdcIn.toString(),
                price: f.price.toString(),
                quantity: f.quantity.toString(),
                // only on a sale, so a buy reads exactly as it always did
                ...(f.side === "sell" && {
                    side: "sell" as const,
                    proceedsUsdc: f.proceedsUsdc!.toString(),
                    realizedUsdc: f.realizedUsdc!.toString(),
                }),
            })),
        };
    }

    /**
     * Sends one swap per order and reports what each returned.
     *
     * Stops at the first failure rather than carrying on. With real money, a swap that failed is a
     * reason to look rather than a reason to try the next one, and the legs that did not execute are
     * simply not booked.
     *
     * The key is the proposal and the position in the plan, so a retry of the same proposal resumes
     * each swap instead of sending it again.
     */
    private async sendSwaps(
        id: string,
        legs: readonly Leg[],
        quotes: ReadonlyMap<string, Quote>,
    ): Promise<{ realized: Map<number, RealizedFill[]>; problems: string[] }> {
        const executor = this.deps.executor!;
        const plan = swapPlan(legs, this.mandates.current().terms.maxTradeUsdc);
        const realized = new Map<number, RealizedFill[]>();
        const problems: string[] = [];

        for (const [position, order] of plan.entries()) {
            const quote = quotes.get(order.asset.toLowerCase());
            if (quote === undefined) {
                problems.push(`${order.symbol}: no usable quote, so nothing was sent for it`);
                break;
            }
            try {
                const filled = await executor.fill(order, quote, `${id}:${position}`);
                this.attribute(realized, legs, plan, position, filled.amountOut, filled.transaction);
            } catch (e) {
                problems.push(`${order.symbol}: ${e instanceof Error ? e.message : String(e)}`);
                break;
            }
        }

        return { realized, problems };
    }

    /** Adds one swap's result to the legs that paid for it, each under that swap's own transaction. */
    private attribute(
        into: Map<number, RealizedFill[]>,
        legs: readonly Leg[],
        plan: readonly SwapOrder[],
        position: number,
        amountOut: bigint,
        transaction: string,
    ): void {
        for (const share of orderShares(legs, plan, position, amountOut)) {
            const { leg, ...fill } = share;
            into.set(leg, [...(into.get(leg) ?? []), { ...fill, transaction }]);
        }
    }

    /**
     * Puts into the books any swap that happened and is not there.
     *
     * Booking follows a swap in the same request, so a process that is replaced, or that stops waiting
     * for a receipt, leaves money moved that the ledger does not show. The journal knows about it. This
     * resolves what is unresolved against the chain, then books every filled swap the ledger lacks,
     * rebuilding which legs it was for from the stored proposal and the mandate version it was signed
     * under.
     *
     * Only a mainnet book is ever written: the journal holds real swaps, and a simulated book must not.
     * `except` names a proposal that is about to be executed again, which books its own.
     */
    async reconcileSwaps(except?: string): Promise<Reconciliation> {
        const executor = this.deps.executor;
        const out: Reconciliation = { recovered: [], outstanding: [] };
        if (this.deps.mode !== "mainnet" || executor?.records === undefined) return out;

        await executor.recover?.();
        const { filled, unresolved } = await executor.records();
        // a key is the proposal id, a colon and the position in its swap plan
        const proposalOf = (key: string): string => key.slice(0, key.lastIndexOf(":"));

        for (const r of unresolved) {
            if (proposalOf(r.key) === except) continue;
            out.outstanding.push(
                `the ${r.symbol} swap ${r.txHash ?? r.key} was sent and has no known outcome yet`,
            );
        }

        const entries = this.treasury.ledger.all();
        const missing = new Map<string, ExecutionRecord[]>();
        for (const r of filled) {
            const id = proposalOf(r.key);
            if (id === except) continue;
            const inBooks = entries.some(
                (t) => t.txHash === r.txHash && t.idempotencyKey?.startsWith(`fill:${id}:`) === true,
            );
            if (!inBooks) missing.set(id, [...(missing.get(id) ?? []), r]);
        }

        for (const [id, records] of missing) {
            try {
                await this.load(id);
                const rec = this.treasury.proposal(id);
                if (rec.approval === undefined) throw new Error("the proposal carries no approval");
                const young = records.some((r) => this.now().getTime() - Date.parse(r.at) < STILL_EXECUTING_MS);
                if (rec.machine.state === "APPROVED" && young) {
                    out.outstanding.push(
                        `proposal ${id} may still be executing; execute it again, or retry in two minutes`,
                    );
                    continue;
                }
                const signedUnder = this.mandates.get(rec.approval.mandateVersion);
                if (signedUnder === undefined) throw new Error("the mandate it was signed under is not on record");
                const legs = rec.proposal.legs;
                const plan = swapPlan(legs, signedUnder.terms.maxTradeUsdc);

                const realized = new Map<number, RealizedFill[]>();
                // every filled swap of this proposal, so each leg's coverage is judged whole
                for (const r of filled.filter((x) => proposalOf(x.key) === id)) {
                    const position = Number(r.key.slice(r.key.lastIndexOf(":") + 1));
                    const order = plan[position];
                    if (
                        order === undefined ||
                        order.asset.toLowerCase() !== r.asset.toLowerCase() ||
                        order.usdcIn !== r.usdcInMinor ||
                        (order.side ?? "buy") !== (r.side ?? "buy")
                    ) {
                        throw new Error(`swap ${r.key} does not match the proposal's plan`);
                    }
                    if (r.txHash === undefined || r.amountOutMinor === undefined || r.amountOutMinor <= 0n) {
                        throw new Error(`swap ${r.key} is recorded as filled but is missing its result`);
                    }
                    this.attribute(realized, legs, plan, position, r.amountOutMinor, r.txHash);
                }

                this.treasury.bookExecuted(id, realized);
                await this.flush();
                await this.save(id);
                for (const r of records) {
                    out.recovered.push({ proposalId: id, symbol: r.symbol, transaction: r.txHash! });
                    log.info("execution_booked", `booked a swap that was missing from the books: ${r.key}`, {
                        key: r.key, symbol: r.symbol, transaction: r.txHash,
                    });
                }
            } catch (e) {
                const why = e instanceof Error ? e.message : String(e);
                out.outstanding.push(
                    `swaps of proposal ${id} (${records.map((r) => r.txHash).join(", ")}) are not in the books: ${why}`,
                );
                log.error("execution_unbooked", `could not book the swaps of proposal ${id}`, {
                    proposal: id, ...errorFields(e),
                });
            }
        }
        return out;
    }

    view(id: string): ProposalView {
        const rec = this.treasury.proposal(id);
        const mandate = this.mandates.current();
        const plan = swapPlan(rec.proposal.legs, mandate.terms.maxTradeUsdc);
        const total = rec.proposal.legs.reduce((a, l) => a + l.usdcIn, 0n);
        if (swapPlanTotal(plan) !== total) throw new Error("swap plan does not spend what the legs spend");
        return {
            id: rec.id,
            state: rec.machine.state,
            hash: proposalHash(rec.proposal, mandate.hash),
            mandateVersion: mandate.version,
            mandateHash: mandate.hash,
            totalUsdcIn: total.toString(),
            legs: rec.proposal.legs.map((l) => ({
                symbol: l.symbol, asset: l.asset, theme: l.theme, usdcIn: l.usdcIn.toString(),
            })),
            swaps: plan.map((o) => ({
                symbol: o.symbol,
                usdcIn: o.usdcIn.toString(),
                parts: o.parts.map((p) => ({ theme: p.theme, usdcIn: p.usdcIn.toString() })),
            })),
            createdAt: this.now().toISOString(),
        };
    }

    /**
     * Proposals this process has offered or been asked about, tracked directly rather than parsed back
     * out of ledger memos. Storage is read by id, so this is not a list of everything ever proposed.
     */
    ids(): string[] {
        return [...this.proposalIds];
    }
}
