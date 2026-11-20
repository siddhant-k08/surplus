import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger";
import { parseUsdc as u } from "../src/money";

const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, s));

describe("ledger", () => {
  it("posts a balanced transaction and updates balances", () => {
    const l = new Ledger();
    l.post({
      type: "PAYMENT_RECEIVED",
      mode: "sim",
      at: t(0),
      lines: [
        { account: "cash.operating", amount: u("3") },
        { account: "revenue.research", amount: u("-3") },
      ],
    });
    expect(l.balance("cash.operating")).toBe(u("3"));
    expect(l.balance("revenue.research")).toBe(u("-3"));
    expect(l.all()).toHaveLength(1);
  });

  it("rejects unbalanced transactions", () => {
    const l = new Ledger();
    expect(() =>
      l.post({
        type: "PAYMENT_RECEIVED",
        mode: "sim",
        lines: [
          { account: "cash.operating", amount: u("3") },
          { account: "revenue.research", amount: u("-2") },
        ],
      }),
    ).toThrow(/Unbalanced/);
    expect(l.all()).toHaveLength(0);
  });

  it("rejects zero-amount lines", () => {
    const l = new Ledger();
    expect(() =>
      l.post({
        type: "COST_ACCRUED",
        mode: "sim",
        lines: [
          { account: "expense.llm", amount: 0n },
          { account: "cash.operating", amount: 0n },
        ],
      }),
    ).toThrow(/Zero-amount/);
  });

  it("is idempotent on the same key", () => {
    const l = new Ledger();
    const input = {
      type: "PAYMENT_RECEIVED" as const,
      mode: "sim" as const,
      at: t(0),
      idempotencyKey: "0xabc",
      lines: [
        { account: "cash.operating" as const, amount: u("3") },
        { account: "revenue.research" as const, amount: u("-3") },
      ],
    };
    const first = l.post(input);
    const second = l.post(input);
    expect(second).toBe(first);
    expect(l.balance("cash.operating")).toBe(u("3"));
    expect(l.all()).toHaveLength(1);
  });

  it("rejects reusing a key with different lines", () => {
    const l = new Ledger();
    l.post({
      type: "PAYMENT_RECEIVED",
      mode: "sim",
      at: t(0),
      idempotencyKey: "0xabc",
      lines: [
        { account: "cash.operating", amount: u("3") },
        { account: "revenue.research", amount: u("-3") },
      ],
    });
    expect(() =>
      l.post({
        type: "PAYMENT_RECEIVED",
        mode: "sim",
        at: t(1),
        idempotencyKey: "0xabc",
        lines: [
          { account: "cash.operating", amount: u("4") },
          { account: "revenue.research", amount: u("-4") },
        ],
      }),
    ).toThrow(/reused/);
  });

  it("enforces chronological order", () => {
    const l = new Ledger();
    l.post({ type: "REFUSAL", mode: "sim", at: t(10), lines: [] });
    expect(() =>
      l.post({ type: "REFUSAL", mode: "sim", at: t(5), lines: [] }),
    ).toThrow(/Out-of-order/);
  });

  it("allows event-only records with no lines", () => {
    const l = new Ledger();
    const tx = l.post({ type: "PROPOSAL_CREATED", mode: "sim", at: t(0), lines: [] });
    expect(tx.lines).toHaveLength(0);
    expect(l.all()).toHaveLength(1);
  });

  it("reproduces the section 3 worked example", () => {
    const l = new Ledger();
    // Opening reserve of 1.50
    l.post({
      type: "OPENING_BALANCE", mode: "sim", at: t(0),
      lines: [
        { account: "reserve", amount: u("1.50") },
        { account: "equity.opening", amount: u("-1.50") },
      ],
    });
    // Customer pays 3.00
    l.post({
      type: "PAYMENT_RECEIVED", mode: "sim", at: t(1),
      lines: [
        { account: "cash.operating", amount: u("3") },
        { account: "revenue.research", amount: u("-3") },
      ],
    });
    // Metered costs 0.50 + 0.10
    l.post({
      type: "COST_ACCRUED", mode: "sim", at: t(2),
      lines: [
        { account: "expense.llm", amount: u("0.50") },
        { account: "cash.operating", amount: u("-0.50") },
      ],
    });
    l.post({
      type: "COST_ACCRUED", mode: "sim", at: t(3),
      lines: [
        { account: "expense.search", amount: u("0.10") },
        { account: "cash.operating", amount: u("-0.10") },
      ],
    });
    // Reserve top-up 0.50
    l.post({
      type: "RESERVE_TOPUP", mode: "sim", at: t(4),
      lines: [
        { account: "reserve", amount: u("0.50") },
        { account: "cash.operating", amount: u("-0.50") },
      ],
    });

    expect(l.balance("cash.operating")).toBe(u("1.90")); // the surplus
    expect(l.balance("reserve")).toBe(u("2.00"));
    expect(l.balance("revenue.research")).toBe(u("-3"));

    let total = 0n;
    for (const v of l.balances().values()) total += v;
    expect(total).toBe(0n);
  });

  it("replay rebuilds identical balances", () => {
    const l = new Ledger();
    l.post({
      type: "PAYMENT_RECEIVED", mode: "sim", at: t(0), idempotencyKey: "k1",
      lines: [
        { account: "cash.operating", amount: u("3") },
        { account: "revenue.research", amount: u("-3") },
      ],
    });
    l.post({
      type: "COST_ACCRUED", mode: "sim", at: t(1),
      lines: [
        { account: "expense.llm", amount: u("0.50") },
        { account: "cash.operating", amount: u("-0.50") },
      ],
    });
    const again = Ledger.replay(l.all());
    expect([...again.balances()]).toEqual([...l.balances()]);
  });

  it("replay restores every field, not just the amounts", () => {
    const l = new Ledger();
    l.post({
      type: "PAYMENT_RECEIVED", mode: "testnet", at: t(0),
      idempotencyKey: "x402:0xfeed", txHash: "0xfeed", memo: "first sale",
      lines: [
        { account: "cash.operating", amount: u("0.01") },
        { account: "revenue.research", amount: u("-0.01") },
      ],
    });
    const again = Ledger.replay(l.all());
    expect(again.all()).toEqual(l.all());
    const back = again.all()[0]!;
    expect(back.txHash).toBe("0xfeed");          // the onchain link must survive
    expect(back.idempotencyKey).toBe("x402:0xfeed");
    expect(back.memo).toBe("first sale");
  });

  it("a replayed ledger still refuses a duplicate payment", () => {
    const l = new Ledger();
    const sale = {
      type: "PAYMENT_RECEIVED" as const, mode: "testnet" as const, at: t(0),
      idempotencyKey: "x402:0xfeed", txHash: "0xfeed",
      lines: [
        { account: "cash.operating" as const, amount: u("0.01") },
        { account: "revenue.research" as const, amount: u("-0.01") },
      ],
    };
    l.post(sale);
    const again = Ledger.replay(l.all());
    // the same settlement arriving again after a restart must not book twice
    again.post(sale);
    expect(again.all().length).toBe(1);
    expect(again.balance("cash.operating")).toBe(u("0.01"));
  });
});