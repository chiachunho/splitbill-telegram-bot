import { and, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { db } from "@/db";
import { expensePayers, expenseSplits, expenses } from "@/db/schema";
import type { McpAuth } from "@/lib/auth/mcp";
import { encodeExpenseCursor, EXPENSES_PAGE_SIZE, parseExpenseCursor } from "@/lib/expense-cursor";
import { n } from "@/lib/money";
import { daySchema, idSchema } from "@/lib/zod";

import { openGroup } from "../context";
import { guarded, ok, ToolError } from "../result";

const READ = { readOnlyHint: true, openWorldHint: false } as const;

type Labels = Map<number, string>;

/** Records with their payers and splits, shaped for an agent. */
export async function loadMcpRecords(groupId: number, ids: number[], labels: Labels) {
  if (ids.length === 0) return [];
  const [rows, payers, splits] = await Promise.all([
    db
      .select({
        id: expenses.id,
        type: expenses.type,
        amount: expenses.amount,
        currency: expenses.currency,
        description: expenses.description,
        spentAt: expenses.spentAt,
        createdBy: expenses.createdBy,
        createdAt: expenses.createdAt,
      })
      .from(expenses)
      .where(and(eq(expenses.groupId, groupId), inArray(expenses.id, ids))),
    db.select().from(expensePayers).where(inArray(expensePayers.expenseId, ids)),
    db.select().from(expenseSplits).where(inArray(expenseSplits.expenseId, ids)),
  ]);
  const label = (id: number) => labels.get(id) ?? "?";
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({
      recordId: r.id,
      type: r.type,
      amount: n(r.amount),
      currency: r.currency,
      description: r.description,
      spentAt: r.spentAt,
      createdByMemberId: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      payers: payers
        .filter((p) => p.expenseId === r.id)
        .map((p) => ({ memberId: p.payerId, label: label(p.payerId), amount: n(p.amount) })),
      splits: splits
        .filter((s) => s.expenseId === r.id)
        .map((s) => ({
          memberId: s.debtorId,
          label: label(s.debtorId),
          amount: n(s.amount),
          shareType: s.shareType,
          weight: s.splitValue != null ? n(s.splitValue) : null,
        })),
    }));
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function registerRecordTools(server: McpServer, auth: McpAuth) {
  server.registerTool(
    "list_records",
    {
      title: "List records",
      description:
        "Expenses and settlements, newest first (by date, then entry order). Pass the previous nextCursor to get the next page. Filters: from/to (YYYY-MM-DD, inclusive), keyword in the description, mineOnly.",
      inputSchema: {
        groupId: idSchema,
        cursor: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(EXPENSES_PAGE_SIZE).optional(),
        from: daySchema.optional(),
        to: daySchema.optional(),
        keyword: z.string().trim().min(1).max(100).optional(),
        mineOnly: z.boolean().optional(),
      },
      annotations: READ,
    },
    (args) =>
      guarded(async () => {
        const { labels } = await openGroup(auth, args.groupId, "read");
        const cursor = args.cursor != null ? parseExpenseCursor(args.cursor) : null;
        if (args.cursor != null && !cursor) throw new ToolError("bad_request", "invalid cursor");
        const limit = args.limit ?? EXPENSES_PAGE_SIZE;
        const me = auth.user.id;

        const fetched = await db
          .select({ id: expenses.id, spentAt: expenses.spentAt })
          .from(expenses)
          .where(
            and(
              eq(expenses.groupId, args.groupId),
              cursor
                ? sql`(${expenses.spentAt}, ${expenses.id}) < (${cursor.spentAt}::date, ${cursor.id})`
                : undefined,
              args.from ? sql`${expenses.spentAt} >= ${args.from}::date` : undefined,
              args.to ? sql`${expenses.spentAt} <= ${args.to}::date` : undefined,
              args.keyword
                ? ilike(expenses.description, `%${escapeLike(args.keyword)}%`)
                : undefined,
              args.mineOnly
                ? or(
                    exists(
                      db
                        .select({ one: sql`1` })
                        .from(expensePayers)
                        .where(
                          and(
                            eq(expensePayers.expenseId, expenses.id),
                            eq(expensePayers.payerId, me),
                          ),
                        ),
                    ),
                    exists(
                      db
                        .select({ one: sql`1` })
                        .from(expenseSplits)
                        .where(
                          and(
                            eq(expenseSplits.expenseId, expenses.id),
                            eq(expenseSplits.debtorId, me),
                          ),
                        ),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(expenses.spentAt), desc(expenses.id))
          .limit(limit + 1);

        const page = fetched.slice(0, limit);
        const last = page[page.length - 1];
        const nextCursor =
          fetched.length > limit && last
            ? encodeExpenseCursor({ spentAt: last.spentAt, id: last.id })
            : null;
        const records = await loadMcpRecords(
          args.groupId,
          page.map((r) => r.id),
          labels,
        );
        return ok(`${records.length} record(s)${nextCursor ? ", more available" : ""}`, {
          records,
          nextCursor,
        });
      }),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get record",
      description: "One expense or settlement with its payers and splits.",
      inputSchema: { groupId: idSchema, recordId: idSchema },
      annotations: READ,
    },
    ({ groupId, recordId }) =>
      guarded(async () => {
        const { labels } = await openGroup(auth, groupId, "read");
        const [record] = await loadMcpRecords(groupId, [recordId], labels);
        if (!record) throw new ToolError("not_found", "record not found");
        return ok(`record ${recordId}`, { record });
      }),
  );
}
