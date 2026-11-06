import { eq, inArray, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { db } from "@/db";
import { groupMembers, groups } from "@/db/schema";
import { grantCovers } from "@/lib/mcp/grant";
import type { McpAuth } from "@/lib/auth/mcp";
import { enforceMcpRateLimit } from "@/lib/rate-limit";
import { idSchema, SUPPORTED_CURRENCIES } from "@/lib/zod";
import { computeGroupBalances, minimizeTransfers } from "@/lib/settlement";

import { openGroup } from "../context";
import { guarded, ok } from "../result";

const READ = { readOnlyHint: true, openWorldHint: false } as const;

export function registerGroupTools(server: McpServer, auth: McpAuth) {
  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "Groups this connection may use, with default currency, member count and my net balance (positive = owed to me), in the group's default currency.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guarded(async () => {
        await enforceMcpRateLimit(auth.grant.connectionId, "read");
        const mine = await db
          .select({ id: groups.id, title: groups.title, defaultCurrency: groups.defaultCurrency })
          .from(groupMembers)
          .innerJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(eq(groupMembers.userId, auth.user.id));
        const allowed = mine.filter((g) => grantCovers(auth.grant, g.id));
        const ids = allowed.map((g) => g.id);
        const counts = ids.length
          ? await db
              .select({ groupId: groupMembers.groupId, n: sql<number>`count(*)::int` })
              .from(groupMembers)
              .where(inArray(groupMembers.groupId, ids))
              .groupBy(groupMembers.groupId)
          : [];
        const countOf = new Map(counts.map((c) => [c.groupId, c.n]));
        // Each balance is its own set of queries (and possibly a rate lookup); run them together.
        const out = await Promise.all(
          allowed.map(async (g) => {
            const balances = await computeGroupBalances(g.id, g.defaultCurrency);
            return {
              groupId: g.id,
              title: g.title,
              defaultCurrency: g.defaultCurrency,
              memberCount: countOf.get(g.id) ?? 0,
              myNet: balances.find((b) => b.userId === auth.user.id)?.amount ?? 0,
            };
          }),
        );
        return ok(`${out.length} group(s)`, { groups: out });
      }),
  );

  server.registerTool(
    "get_group",
    {
      title: "Get group",
      description:
        "A group's members (memberId, display name, username, placeholder and active flags), supported currencies and time zone. Use memberId to name people unambiguously.",
      inputSchema: { groupId: idSchema },
      annotations: READ,
    },
    ({ groupId }) =>
      guarded(async () => {
        const { group, members, labels } = await openGroup(auth, groupId, "read");
        return ok(`group ${group.id}: ${members.length} member(s)`, {
          groupId: group.id,
          title: group.title,
          defaultCurrency: group.defaultCurrency,
          timeZone: group.timezone,
          supportedCurrencies: [...SUPPORTED_CURRENCIES],
          members: members.map((m) => ({
            memberId: m.id,
            label: labels.get(m.id) ?? "?",
            displayName: m.displayName,
            firstName: m.firstName,
            lastName: m.lastName,
            username: m.username,
            placeholder: m.placeholder,
            active: m.active,
            isMe: m.id === auth.user.id,
          })),
        });
      }),
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get balance",
      description:
        "Net balance per member (positive = is owed) and the suggested minimum repayments, in the group's default currency.",
      inputSchema: { groupId: idSchema },
      annotations: READ,
    },
    ({ groupId }) =>
      guarded(async () => {
        const { group, labels } = await openGroup(auth, groupId, "read");
        const balances = await computeGroupBalances(groupId, group.defaultCurrency);
        const label = (id: number) => labels.get(id) ?? "?";
        return ok(`${balances.length} balance(s) in ${group.defaultCurrency}`, {
          currency: group.defaultCurrency,
          balances: balances.map((b) => ({
            memberId: b.userId,
            label: label(b.userId),
            amount: b.amount,
          })),
          suggestedTransfers: minimizeTransfers(balances).map((t) => ({
            fromMemberId: t.fromUserId,
            fromLabel: label(t.fromUserId),
            toMemberId: t.toUserId,
            toLabel: label(t.toUserId),
            amount: t.amount,
          })),
        });
      }),
  );
}
