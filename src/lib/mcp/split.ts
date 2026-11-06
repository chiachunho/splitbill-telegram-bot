import { splitEqual } from "@/lib/money";
import { expenseInputSchema, type ExpenseInput, type SupportedCurrency } from "@/lib/zod";

/**
 * Builds the `expenseInputSchema` payload from what an agent said, with the people already
 * resolved to user ids. Pure: rounding and sums are the part that must not drift from the
 * forms, and the result still goes through the same schema the REST route uses.
 */

export type McpPayer = { userId: number; amount?: number };
export type McpSplit =
  | { type: "equal"; userIds: number[] }
  | { type: "shares"; shares: { userId: number; weight: number }[] }
  | { type: "exact"; amounts: { userId: number; amount: number }[] };

export type BuildResult = { ok: true; input: ExpenseInput } | { ok: false; message: string };

const cents = (v: number) => Math.round(v * 100);

/** `total` split by weights in whole cents; leftovers go to the largest fractions first. */
export function allocateByWeights(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const totalCents = cents(total);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const out = raw.map(Math.floor);
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out.map((c) => c / 100);
}

const dup = (ids: number[]) => ids.length !== new Set(ids).size;

export function buildExpenseInput(args: {
  amount: number;
  currency: SupportedCurrency;
  description: string | null;
  spentAt: string;
  payers: McpPayer[];
  split: McpSplit;
  fxRate?: number | null;
}): BuildResult {
  const { amount, payers, split } = args;
  const fail = (message: string): BuildResult => ({ ok: false, message });

  if (payers.length === 0) return fail("at least one payer is required");
  if (dup(payers.map((p) => p.userId))) return fail("a payer is listed twice");
  let payerRows: { payerId: number; amount: number }[];
  if (payers.length === 1 && payers[0].amount === undefined) {
    payerRows = [{ payerId: payers[0].userId, amount }];
  } else {
    if (payers.some((p) => p.amount === undefined)) {
      return fail("with several payers, every payer needs an amount");
    }
    payerRows = payers.map((p) => ({ payerId: p.userId, amount: p.amount! }));
    if (cents(payerRows.reduce((s, p) => s + p.amount, 0)) !== cents(amount)) {
      return fail("payer amounts must add up to the expense amount");
    }
  }

  let splitRows: { debtorId: number; amount: number; splitValue: number | null }[];
  if (split.type === "equal") {
    if (split.userIds.length === 0) return fail("at least one person must share the expense");
    if (dup(split.userIds)) return fail("a person is listed twice in the split");
    const parts = splitEqual(amount, split.userIds.length);
    splitRows = split.userIds.map((id, i) => ({
      debtorId: id,
      amount: parts[i],
      splitValue: null,
    }));
  } else if (split.type === "shares") {
    if (split.shares.length === 0) return fail("at least one person must share the expense");
    if (dup(split.shares.map((s) => s.userId)))
      return fail("a person is listed twice in the split");
    if (split.shares.some((s) => !(s.weight > 0))) return fail("share weights must be positive");
    const parts = allocateByWeights(
      amount,
      split.shares.map((s) => s.weight),
    );
    splitRows = split.shares.map((s, i) => ({
      debtorId: s.userId,
      amount: parts[i],
      splitValue: s.weight,
    }));
  } else {
    if (split.amounts.length === 0) return fail("at least one person must share the expense");
    if (dup(split.amounts.map((s) => s.userId)))
      return fail("a person is listed twice in the split");
    if (split.amounts.some((s) => !(s.amount >= 0))) return fail("exact amounts can't be negative");
    if (cents(split.amounts.reduce((s, x) => s + x.amount, 0)) !== cents(amount)) {
      return fail("exact amounts must add up to the expense amount");
    }
    splitRows = split.amounts.map((s) => ({
      debtorId: s.userId,
      amount: s.amount,
      splitValue: null,
    }));
  }

  const parsed = expenseInputSchema.safeParse({
    amount,
    currency: args.currency,
    fxRate: args.fxRate ?? null,
    description: args.description,
    payers: payerRows,
    spentAt: args.spentAt,
    shareType: split.type,
    splits: splitRows,
  });
  return parsed.success ? { ok: true, input: parsed.data } : fail(parsed.error.issues[0].message);
}
