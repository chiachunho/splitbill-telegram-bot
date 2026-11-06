import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { db } from "@/db";
import { expensePayers, expenses } from "@/db/schema";
import { parseMcpAmount } from "@/lib/mcp/amount";
import { bindKey, claimKey, duplicateSince, releaseKey } from "@/lib/mcp/idempotency";
import { resolveMember } from "@/lib/mcp/names";
import { buildExpenseInput, type McpPayer, type McpSplit } from "@/lib/mcp/split";
import type { McpAuth } from "@/lib/auth/mcp";
import { todayIn } from "@/lib/day";
import { createExpense, createSettlement } from "@/lib/records";
import {
  daySchema,
  idSchema,
  settlementInputSchema,
  SUPPORTED_CURRENCIES,
  type SupportedCurrency,
} from "@/lib/zod";

import { openGroup, type McpMember } from "../context";
import { guarded, ok, ToolError } from "../result";

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const memberRef = z
  .union([idSchema, z.string().trim().min(1).max(100)])
  .describe("a memberId from get_group (preferred), or a name / @username in this group");
const keySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .optional()
  .describe("Send the same key when retrying so the record is not created twice (kept 24 h).");

const ME_WORDS = new Set(["me", "myself", "self", "我", "本人"]);

function makeResolver(members: McpMember[], meId: number) {
  return (ref: number | string): McpMember => {
    if (typeof ref === "string" && ME_WORDS.has(ref.trim().toLowerCase())) {
      const me = members.find((m) => m.id === meId);
      if (me) return me;
    }
    const r = resolveMember(ref, members);
    if (r.ok) return r.member;
    throw new ToolError(
      r.code,
      r.code === "member_ambiguous"
        ? `more than one member matches "${r.query.slice(0, 40)}"; use a memberId`
        : `no member matches "${r.query.slice(0, 40)}"`,
      { candidates: r.candidates },
    );
  };
}

const splitSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("equal"),
    among: z.array(memberRef).min(1).max(50).optional().describe("Default: every active member."),
  }),
  z.object({
    type: z.literal("shares"),
    shares: z
      .array(z.object({ member: memberRef, weight: z.number().positive().max(1000) }))
      .min(1)
      .max(50),
  }),
  z.object({
    type: z.literal("exact"),
    amounts: z
      .array(z.object({ member: memberRef, amount: z.number().nonnegative() }))
      .min(1)
      .max(50),
  }),
]);

/** The currency of a call: the argument, else one written into the amount, else the group's. */
function resolveCurrency(
  explicit: SupportedCurrency | undefined,
  fromAmount: SupportedCurrency | null,
  groupDefault: string,
): SupportedCurrency {
  if (fromAmount && explicit && fromAmount !== explicit) {
    throw new ToolError("bad_request", "currency in amount conflicts with the currency argument");
  }
  const currency = explicit ?? fromAmount ?? groupDefault;
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    throw new ToolError("bad_request", `unsupported currency ${currency}`);
  }
  return currency as SupportedCurrency;
}

const mcpActor = (auth: McpAuth) => ({
  userId: auth.user.id,
  source: "mcp" as const,
  mcpConnectionId: auth.grant.connectionId,
});

type Reservation = { release: () => Promise<void>; bind: (id: number) => Promise<void> };

/** Handles `idempotencyKey`; returns an early result for a repeat, else a reservation. */
async function reserve(auth: McpAuth, key: string | undefined) {
  if (!key) return { reservation: null as Reservation | null };
  const connId = auth.grant.connectionId;
  const claim = await claimKey(connId, key);
  if (claim.status === "duplicate") {
    return {
      early: ok(`duplicate of record ${claim.recordId}`, {
        status: "duplicate",
        recordId: claim.recordId,
      }),
    };
  }
  if (claim.status === "in_progress") {
    throw new ToolError(
      "in_progress",
      "a call with this idempotencyKey is still running; retry shortly",
    );
  }
  return {
    reservation: {
      release: () => releaseKey(connId, key),
      bind: (id: number) => bindKey(connId, key, id),
    } satisfies Reservation,
  };
}

export function registerWriteTools(server: McpServer, auth: McpAuth) {
  server.registerTool(
    "add_expense",
    {
      title: "Add expense",
      description:
        "Record an expense. amount may be a number or text like '1,200', '$300', '3k', '150+200'. Payer defaults to me; split defaults to equal among all active members. People are matched by exact name within the group; if a name is not found or matches several members you get candidates back and nothing is written. Use dryRun to preview. If an identical expense (same amount, currency and payer) was recorded in the last 10 minutes nothing is written and possibleDuplicateOf is returned; resend with allowDuplicate: true if it is intended.",
      inputSchema: {
        groupId: idSchema,
        amount: z.union([z.number().positive().max(10_000_000), z.string().min(1).max(60)]),
        currency: z
          .enum(SUPPORTED_CURRENCIES)
          .optional()
          .describe("Default: the group's default currency."),
        description: z.string().trim().max(500).optional(),
        spentAt: daySchema
          .optional()
          .describe("YYYY-MM-DD in the group's time zone. Default: today there."),
        paidBy: memberRef.optional().describe("Single payer, default me."),
        payers: z
          .array(z.object({ member: memberRef, amount: z.number().positive() }))
          .min(1)
          .max(20)
          .optional()
          .describe("Several payers with amounts adding up to the total (instead of paidBy)."),
        split: splitSchema.optional(),
        idempotencyKey: keySchema,
        dryRun: z.boolean().optional(),
        allowDuplicate: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      guarded(async () => {
        const { group, members, labels } = await openGroup(auth, args.groupId, "write", {
          countAs: args.dryRun ? "read" : "write",
        });
        const find = makeResolver(members, auth.user.id);

        const parsed = parseMcpAmount(args.amount);
        if (!parsed.ok) throw new ToolError("bad_request", parsed.message);
        const currency = resolveCurrency(args.currency, parsed.currency, group.defaultCurrency);
        const spentAt = args.spentAt ?? todayIn(group.timezone);

        if (args.payers && args.paidBy !== undefined) {
          throw new ToolError("bad_request", "use paidBy or payers, not both");
        }
        const payers: McpPayer[] = args.payers
          ? args.payers.map((p) => ({ userId: find(p.member).id, amount: p.amount }))
          : [{ userId: args.paidBy !== undefined ? find(args.paidBy).id : auth.user.id }];

        const split = args.split ?? { type: "equal" as const };
        let mcpSplit: McpSplit;
        if (split.type === "equal") {
          mcpSplit = {
            type: "equal",
            userIds: split.among
              ? split.among.map((r) => find(r).id)
              : members.filter((m) => m.active).map((m) => m.id),
          };
        } else if (split.type === "shares") {
          mcpSplit = {
            type: "shares",
            shares: split.shares.map((s) => ({ userId: find(s.member).id, weight: s.weight })),
          };
        } else {
          mcpSplit = {
            type: "exact",
            amounts: split.amounts.map((s) => ({ userId: find(s.member).id, amount: s.amount })),
          };
        }

        const built = buildExpenseInput({
          amount: parsed.amount,
          currency,
          description: args.description || null,
          spentAt,
          payers,
          split: mcpSplit,
        });
        if (!built.ok) throw new ToolError("bad_request", built.message);

        const label = (id: number) => labels.get(id) ?? "?";
        const preview = {
          amount: built.input.amount,
          currency,
          description: built.input.description,
          spentAt,
          shareType: built.input.shareType,
          payers: built.input.payers.map((p) => ({
            memberId: p.payerId,
            label: label(p.payerId),
            amount: p.amount,
          })),
          splits: built.input.splits.map((s) => ({
            memberId: s.debtorId,
            label: label(s.debtorId),
            amount: s.amount,
          })),
        };
        if (args.dryRun) return ok("dry run: nothing written", { status: "dry_run", preview });

        const held = await reserve(auth, args.idempotencyKey);
        if (held.early) return held.early;
        const reservation = held.reservation;

        try {
          if (!args.allowDuplicate && built.input.payers.length === 1) {
            const [dup] = await db
              .select({ id: expenses.id })
              .from(expenses)
              .innerJoin(expensePayers, eq(expensePayers.expenseId, expenses.id))
              .where(
                and(
                  eq(expenses.groupId, args.groupId),
                  eq(expenses.type, "expense"),
                  eq(expenses.amount, built.input.amount.toFixed(2)),
                  eq(expenses.currency, currency),
                  eq(expensePayers.payerId, built.input.payers[0].payerId),
                  gte(expenses.createdAt, duplicateSince(new Date())),
                ),
              )
              .limit(1);
            if (dup) {
              await reservation?.release();
              return ok(`possible duplicate of record ${dup.id}; nothing written`, {
                status: "possible_duplicate",
                possibleDuplicateOf: dup.id,
                preview,
              });
            }
          }
          const { id } = await createExpense(args.groupId, built.input, {
            actor: mcpActor(auth),
          });
          // The record exists now: a failed bind must not free the key, or a retry would
          // book it twice.
          await reservation?.bind(id).catch((err) => console.error("[mcp] bindKey failed", err));
          return ok(`created expense ${id}`, { status: "created", recordId: id, preview });
        } catch (err) {
          await reservation?.release().catch(() => {});
          throw err;
        }
      }),
  );

  server.registerTool(
    "add_settlement",
    {
      title: "Add settlement",
      description:
        "Record that one member paid another back (from must differ from to). from defaults to me. Names are matched exactly within the group; on a miss or tie you get candidates and nothing is written.",
      inputSchema: {
        groupId: idSchema,
        from: memberRef.optional().describe("Who paid; default me."),
        to: memberRef.describe("Who received the money."),
        amount: z.union([z.number().positive().max(10_000_000), z.string().min(1).max(60)]),
        currency: z.enum(SUPPORTED_CURRENCIES).optional(),
        settledAt: daySchema
          .optional()
          .describe("YYYY-MM-DD, default today in the group's time zone."),
        idempotencyKey: keySchema,
      },
      annotations: WRITE,
    },
    (args) =>
      guarded(async () => {
        const { group, members } = await openGroup(auth, args.groupId, "write");
        const find = makeResolver(members, auth.user.id);
        const parsed = parseMcpAmount(args.amount);
        if (!parsed.ok) throw new ToolError("bad_request", parsed.message);
        const currency = resolveCurrency(args.currency, parsed.currency, group.defaultCurrency);
        const fromId = args.from !== undefined ? find(args.from).id : auth.user.id;
        const toId = find(args.to).id;
        if (fromId === toId) throw new ToolError("bad_request", "from and to must differ");

        const held = await reserve(auth, args.idempotencyKey);
        if (held.early) return held.early;
        const reservation = held.reservation;

        // Same schema as the REST route: the tool's own checks don't cover the amount range.
        const input = settlementInputSchema.safeParse({
          fromUserId: fromId,
          toUserId: toId,
          amount: parsed.amount,
          currency,
          settledAt: args.settledAt,
        });
        if (!input.success) {
          await reservation?.release().catch(() => {});
          throw new ToolError("bad_request", input.error.issues[0].message);
        }

        try {
          const { id } = await createSettlement(args.groupId, input.data, {
            actor: mcpActor(auth),
          });
          await reservation?.bind(id).catch((err) => console.error("[mcp] bindKey failed", err));
          return ok(`created settlement ${id}`, {
            status: "created",
            recordId: id,
            settlement: { fromMemberId: fromId, toMemberId: toId, amount: parsed.amount, currency },
          });
        } catch (err) {
          await reservation?.release().catch(() => {});
          throw err;
        }
      }),
  );
}
