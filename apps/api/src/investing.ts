import {
    Treasury,
    flushNewEntries,
    allocate,
    toCandidates,
    validateBrief,
    swapPlan,
    swapPlanTotal,
    attributeFills,
    realizedSales,
    investmentGap,
    preTradeChecks,
    blockReasons,
    warnings,
    proposalHash,
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
} from "@surplus/core";

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
    };
    /** The paid endpoint's ledger, read only, as the source of real revenue. */
    salesLedger: () => readonly LedgerTx[];
    market: () => Promise<MarketData>;
    /** Already loaded, because storage is async and a constructor is not. */
    ledger?: Ledger;
    /** Where new entries go. Absent means nothing is persisted. */
    sink?: LedgerSink;
    now?: () => Date;
    /** Required to approve anything. Without it the engine refuses every approval. */
    verifyApproval?: ApprovalVerifier;
    /** Chain id bound into the signed domain, so a testnet signature is not valid elsewhere. */
    chainId: number;
}

/** Brief id used when a sale predates per-sale attribution and does not name its brief. */
export const UNATTRIBUTED = "unattributed";

export interface SyncResult {
    sales: number;
    /** Brief files that could not be read, so their cost is not in the books. */
    unreadableBriefs: { file: string; error: string }[];
    /** Sales whose ledger entry carries no brief id, so their revenue cannot be tied to a brief. */
    unattributedSales: number;
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
        for (const sale of sales) {
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
            gap: this.gap(),
            sales: sales.length,
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

    /**
     * Builds a proposal from the newest brief and live quotes. Never approves it: approval is the owner's
     * separate decision.
     */
    async propose(id: string): Promise<
        | { ok: true; view: ProposalView; toSign: unknown; warnings: string[] }
        | { ok: false; reasons: string[] }
    > {
        const saved = await this.deps.readBrief();
        const market = await this.deps.market();
        const eligible = new Set(market.trusted.map((t) => t.address.toLowerCase()));

        // the brief may predate the current trusted set; refuse rather than trade on a stale one
        const issues = validateBrief(saved.brief, { eligible });
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
            .map((t) => ({ id: t.themeId, candidates: toCandidates(t.fits, market.liquidity, 3, 1) }));
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

        const quoted = await market.quote(alloc.legs);
        const created = this.treasury.createProposal({ id, legs: alloc.legs, quotedPrices: quoted.prices, held });
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

        return {
            ok: true,
            view: this.view(id),
            toSign: approvalTypedDataJson(approval, this.deps.chainId),
            warnings: [
                ...[...quoted.errors].map(([asset, why]) => `no quote for ${asset}: ${why}`),
                ...unfunded.map((t) => `theme ${t} is in the brief but not funded by the mandate, so it was skipped`),
            ],
        };
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
        const approval = this.offered.get(id);
        if (approval === undefined) {
            return { ok: false, reasons: [`no approval payload was offered for ${id}; propose it first`] };
        }

        // The signature covers a mandate version and hash. If the mandate has moved since the offer, the
        // owner authorized constraints that are no longer in force, so the signature must not be usable.
        const mandate = this.mandates.current();
        if (approval.mandateVersion !== mandate.version || approval.mandateHash !== mandate.hash) {
            this.offered.delete(id);
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
            fills: { symbol: string; usdcIn: string; price: string; quantity: string }[];
            /** Legs whose swap did not execute. Not booked, and the proposal is not settled. */
            unfilled: { symbol: string; usdcIn: string; reason: string }[];
            simulated: boolean;
            warnings: string[];
        }
        | { ok: false; reasons: string[]; outcome?: string }
    > {
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
        const sending = this.deps.executor !== undefined && this.deps.mode === "mainnet" && blocks.length === 0;
        const { realized, problems } = sending
            ? await this.sendSwaps(id, rec.proposal.legs, fresh.quotes)
            : { realized: undefined, problems: [] as string[] };

        const result = this.treasury.execute(id, {
            freshPrices: fresh.prices,
            decimals,
            blocks,
            ...(realized !== undefined && { realized }),
        });
        await this.flush();

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
    ): Promise<{ realized: Map<number, RealizedFill>; problems: string[] }> {
        const executor = this.deps.executor!;
        const plan = swapPlan(legs, this.mandates.current().terms.maxTradeUsdc);
        const amounts = new Map<number, bigint>();
        const transactions = new Map<number, string>();
        const problems: string[] = [];

        for (const [position, order] of plan.entries()) {
            const quote = quotes.get(order.asset.toLowerCase());
            if (quote === undefined) {
                problems.push(`${order.symbol}: no usable quote, so nothing was sent for it`);
                break;
            }
            try {
                const filled = await executor.fill(order, quote, `${id}:${position}`);
                amounts.set(position, filled.amountOut);
                transactions.set(position, filled.transaction);
            } catch (e) {
                problems.push(`${order.symbol}: ${e instanceof Error ? e.message : String(e)}`);
                break;
            }
        }

        const perLeg = attributeFills(legs, plan, amounts);
        const realized = new Map<number, RealizedFill>();
        for (const [legIndex, quantity] of perLeg) {
            // the transaction recorded against a leg is the first swap that bought for it
            const position = plan.findIndex(
                (o, p) => amounts.has(p) && o.asset.toLowerCase() === legs[legIndex]!.asset.toLowerCase(),
            );
            realized.set(legIndex, { quantity, transaction: transactions.get(position) ?? "" });
        }
        return { realized, problems };
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
     * Proposals this process knows about, tracked directly rather than parsed back out of ledger memos.
     * They are deliberately not persisted: an approval binds to a quote and expires in minutes, so a
     * proposal must not outlive the process that made it.
     */
    ids(): string[] {
        return [...this.proposalIds];
    }
}
