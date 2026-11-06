import { describe, expect, it } from "vitest";

import { allocateByWeights, buildExpenseInput, type McpSplit } from "@/lib/mcp/split";

const base = { currency: "TWD", description: null, spentAt: "2026-11-06" } as const;

describe("allocateByWeights", () => {
  it("always adds up to the total", () => {
    for (const [total, w] of [
      [100, [1, 1, 1]],
      [10, [2, 1]],
      [0.05, [1, 1, 1]],
      [1234.56, [3, 5, 7, 11]],
    ] as [number, number[]][]) {
      const parts = allocateByWeights(total, w);
      expect(Math.round(parts.reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(total * 100));
    }
  });
  it("gives bigger weights bigger shares", () => {
    expect(allocateByWeights(90, [2, 1])).toEqual([60, 30]);
  });
});

describe("buildExpenseInput", () => {
  it("equal split puts the odd cent on the first person and the sole payer pays all", () => {
    const r = buildExpenseInput({
      ...base,
      amount: 10,
      payers: [{ userId: 1 }],
      split: { type: "equal", userIds: [1, 2, 3] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.splits.map((s) => s.amount)).toEqual([3.34, 3.33, 3.33]);
      expect(r.input.payers).toEqual([{ payerId: 1, amount: 10 }]);
      expect(r.input.shareType).toBe("equal");
    }
  });

  it("shares keep their weights as split values", () => {
    const r = buildExpenseInput({
      ...base,
      amount: 90,
      payers: [{ userId: 1 }],
      split: {
        type: "shares",
        shares: [
          { userId: 1, weight: 2 },
          { userId: 2, weight: 1 },
        ],
      },
    });
    expect(r.ok && r.input.splits).toEqual([
      { debtorId: 1, amount: 60, splitValue: 2 },
      { debtorId: 2, amount: 30, splitValue: 1 },
    ]);
  });

  it("exact amounts must add up", () => {
    const r = buildExpenseInput({
      ...base,
      amount: 100,
      payers: [{ userId: 1 }],
      split: {
        type: "exact",
        amounts: [
          { userId: 1, amount: 40 },
          { userId: 2, amount: 50 },
        ],
      },
    });
    expect(r).toMatchObject({ ok: false });
  });

  it("several payers need amounts that add up", () => {
    const split: McpSplit = { type: "equal", userIds: [1, 2] };
    expect(
      buildExpenseInput({ ...base, amount: 100, payers: [{ userId: 1 }, { userId: 2 }], split }),
    ).toMatchObject({ ok: false });
    expect(
      buildExpenseInput({
        ...base,
        amount: 100,
        payers: [
          { userId: 1, amount: 70 },
          { userId: 2, amount: 20 },
        ],
        split,
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildExpenseInput({
        ...base,
        amount: 100,
        payers: [
          { userId: 1, amount: 70 },
          { userId: 2, amount: 30 },
        ],
        split,
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a person listed twice and an empty split", () => {
    expect(
      buildExpenseInput({
        ...base,
        amount: 10,
        payers: [{ userId: 1 }],
        split: { type: "equal", userIds: [1, 1] },
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildExpenseInput({
        ...base,
        amount: 10,
        payers: [{ userId: 1 }],
        split: { type: "equal", userIds: [] },
      }),
    ).toMatchObject({ ok: false });
  });
});
