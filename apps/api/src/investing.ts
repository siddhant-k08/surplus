import {
    Treasury,
    JsonlLedgerStore,
    flushNewEntries,
    allocate,
    toCandidates,
    validateBrief,
    swapPlan,
    swapPlanTotal,
    realizedSales,
    preTradeChecks,
    blockReasons,
    warnings,
    proposalHash,
    approvalTypedDataJson,
    formatUsdc,
    type LedgerTx,
    type Leg,
    type Approval,
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
    readBrief: () => SavedBrief;
    /** Every brief the agent has produced, so each one's model cost is booked exactly once. */
    allBriefs: () => readonly SavedBrief[];
    /** The paid endpoint's ledger, read only, as the source of real revenue. */
    salesLedger: () => readonly LedgerTx[];
    market: () => Promise<MarketData>;
    store?: JsonlLedgerStore;
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
    /** Sales whose ledger entry carries no brief id, so their revenue cannot be tied to a brief. */
    unattributedSales: number;
    briefsCosted: number;
    revenue: bigint;
    costs: bigint;
    investable: bigint;
    settled: { briefId: string; investable: bigint }[];
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
        const ledger = deps.store?.loadLedger();
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
                    "rebuilds from the sales ledger and the saved briefs, so delete it and let it regenerate: " +
                    (this.deps.store?.path ?? "the investing ledger file"),
                );
            }
        }

        const float = deps.openingFloat ?? 0n;
        if (float > 0n) {
            // idempotent on the amount, so a restart does not fund the agent twice
            this.treasury.ledger.post({
                type: "OPENING_BALANCE",
                mode: deps.mode,
                at: this.now(),
                idempotencyKey: `opening:${float.toString()}`,
                memo: deps.mode === "mainnet"
                    ? "owner-provided working capital"
                    : "owner-provided working capital (simulated)",
                lines: [
                    { account: "cash.operating", amount: float },
                    { account: "equity.opening", amount: -float },
                ],
            });
            this.flush();
        }
    }

    private flush(): void {
        if (this.deps.store !== undefined) {
            this.persistedId = flushNewEntries(this.treasury.ledger, this.deps.store, this.persistedId);
        }
    }

    /**
     * Books any revenue the paid endpoint has taken that this book has not seen, plus the brief's metered
     * model cost, then settles. Idempotent: mirroring twice books nothing the second time.
     *
     * Revenue is mirrored as a total rather than per sale so the entry can name the transactions it stands
     * for. The real money and its onchain proof stay in the endpoint's own ledger.
     */
    syncRevenue(): SyncResult {
        // Every brief the agent produced cost real money, whether or not anyone bought it. Booking only
        // the newest one understated spending as soon as a second brief existed.
        const briefs = this.deps.allBriefs();
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

        this.flush();
        return {
            sales: sales.length,
            unattributedSales: unattributed,
            briefsCosted: briefs.length,
            revenue,
            costs,
            investable: this.treasury.ledger.balance("surplus.investable"),
            settled,
        };
    }

    /**
     * Builds a proposal from the newest brief and live quotes. Never approves it: approval is the owner's
     * separate decision.
     */
    async propose(id: string): Promise<
        | { ok: true; view: ProposalView; toSign: unknown; warnings: string[] }
        | { ok: false; reasons: string[] }
    > {
        const saved = this.deps.readBrief();
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

        const themes = saved.brief.themes.map((t) => ({
            id: t.themeId,
            candidates: toCandidates(t.fits, market.liquidity, 3, 1),
        }));
        const alloc = allocate({ investable, themes, terms: this.mandates.current().terms });
        if (alloc.legs.length === 0) {
            return {
                ok: false,
                reasons: alloc.uninvested.map((x) => `${x.theme ?? "no theme"}: ${formatUsdc(x.amount)} uninvested (${x.reason})`),
            };
        }

        const quoted = await market.quote(alloc.legs);
        const created = this.treasury.createProposal({ id, legs: alloc.legs, quotedPrices: quoted.prices });
        this.proposalIds.add(id);
        this.flush();
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
            warnings: [...quoted.errors].map(([asset, why]) => `no quote for ${asset}: ${why}`),
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

        const verdict = await verify({ approval, signature });
        if (!verdict.ok) return { ok: false, reasons: [verdict.reason] };

        const result = this.treasury.approve(id, verdict.signer, {
            expiresAt: approval.expiresAt,
            signature,
        });
        this.flush();
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
        | { ok: true; fills: { symbol: string; usdcIn: string; price: string; quantity: string }[]; simulated: boolean; warnings: string[] }
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
        const result = this.treasury.execute(id, { freshPrices: fresh.prices, decimals, blocks });
        this.flush();

        if (!result.ok) return { ok: false, reasons: result.reasons, outcome: result.outcome };
        return {
            ok: true,
            simulated: this.deps.mode !== "mainnet",
            warnings: warnings(gates),
            fills: result.fills.map((f) => ({
                symbol: f.symbol,
                usdcIn: f.usdcIn.toString(),
                price: f.price.toString(),
                quantity: f.quantity.toString(),
            })),
        };
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
