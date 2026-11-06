import { randomBytes } from "node:crypto";

import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";

import { db } from "@/db";
import {
  accountMergeTickets,
  authIdentities,
  expensePayers,
  expenses,
  expenseSplits,
  groupDeleteRequests,
  groupMembers,
  groups,
  pushSubscriptions,
  mcpConnections,
  sessions,
  userBeancountConfigs,
  users,
} from "@/db/schema";
import type { AccountMergePreview, AccountMergeSide } from "@/lib/api-types";
import {
  MERGE_TICKET_TTL_SECONDS,
  mergedProfileFields,
  planBeancountConfigs,
  planMembership,
  suggestKeep,
  validateAccountMerge,
} from "@/lib/account-merge";
import { labelUser } from "@/lib/label";
import { findSelfSettlements, planMerge } from "@/lib/member-merge";
import {
  applyMergePlan,
  loadMergeData,
  repointUserReferences,
  type Tx,
} from "@/lib/member-merge-db";

type Executor = Pick<typeof db, "select" | "selectDistinct">;

/** Records the proof the `signIn` callback just saw. Returns the ticket id for the cookie. */
export async function createMergeTicket(
  userId: number,
  otherUserId: number,
  provider: string,
): Promise<string> {
  const now = new Date();
  // Housekeeping: tickets live ten minutes, so anything older is dead weight.
  await db.delete(accountMergeTickets).where(lt(accountMergeTickets.expiresAt, now));
  const id = randomBytes(32).toString("base64url");
  await db.insert(accountMergeTickets).values({
    id,
    userId,
    otherUserId,
    provider,
    expiresAt: new Date(now.getTime() + MERGE_TICKET_TTL_SECONDS * 1000),
  });
  return id;
}

/** The live ticket `id` held by `userId`, or null. A ticket belongs to the session that earned it. */
export async function findMergeTicket(id: string, userId: number) {
  const [row] = await db
    .select()
    .from(accountMergeTickets)
    .where(
      and(
        eq(accountMergeTickets.id, id),
        eq(accountMergeTickets.userId, userId),
        isNull(accountMergeTickets.consumedAt),
        gt(accountMergeTickets.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

/** Marks the ticket used inside the merge transaction, so a second request finds nothing. */
export async function consumeMergeTicket(tx: Tx, id: string, userId: number) {
  const [row] = await tx
    .update(accountMergeTickets)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(accountMergeTickets.id, id),
        eq(accountMergeTickets.userId, userId),
        isNull(accountMergeTickets.consumedAt),
        gt(accountMergeTickets.expiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

export async function discardMergeTicket(id: string, userId: number): Promise<void> {
  await db
    .delete(accountMergeTickets)
    .where(and(eq(accountMergeTickets.id, id), eq(accountMergeTickets.userId, userId)));
}

async function loadAccount(ex: Executor, id: number) {
  const [user] = await ex.select().from(users).where(eq(users.id, id));
  if (!user) return undefined;
  const identities = await ex
    .select({ provider: authIdentities.provider, providerUid: authIdentities.providerUid })
    .from(authIdentities)
    .where(eq(authIdentities.userId, id));
  return { ...user, identities };
}

/** Every expense or settlement the user pays or owes in, across all groups. */
async function recordGroups(ex: Executor, userId: number) {
  return ex
    .selectDistinct({ id: expenses.id, groupId: expenses.groupId })
    .from(expenses)
    .leftJoin(expensePayers, eq(expensePayers.expenseId, expenses.id))
    .leftJoin(expenseSplits, eq(expenseSplits.expenseId, expenses.id))
    .where(or(eq(expensePayers.payerId, userId), eq(expenseSplits.debtorId, userId)));
}

async function memberGroups(ex: Executor, userId: number) {
  return ex
    .select({ groupId: groupMembers.groupId, status: groupMembers.status })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
}

/** What the confirm page shows. Writes nothing. */
export async function previewAccountMerge(
  currentId: number,
  otherId: number,
): Promise<AccountMergePreview | null> {
  const [current, other] = await Promise.all([
    loadAccount(db, currentId),
    loadAccount(db, otherId),
  ]);
  if (!current || !other) return null;
  const check = validateAccountMerge(current, other);

  const [currentRecords, otherRecords, currentGroups, otherGroups] = await Promise.all([
    recordGroups(db, currentId),
    recordGroups(db, otherId),
    memberGroups(db, currentId),
    memberGroups(db, otherId),
  ]);

  const otherGroupIds = new Set(otherGroups.map((g) => g.groupId));
  const sharedIds = currentGroups.map((g) => g.groupId).filter((id) => otherGroupIds.has(id));
  const sharedGroups =
    sharedIds.length === 0
      ? []
      : await db
          .select({ id: groups.id, title: groups.title })
          .from(groups)
          .where(inArray(groups.id, sharedIds))
          .orderBy(groups.id);

  // Same scope `mergeAccounts` deletes from: every group where both have records, member or
  // not. Counting only shared memberships would under-report what "delete" removes.
  const currentRecordGroups = new Set(currentRecords.map((r) => r.groupId));
  const bothRecordGroups = [
    ...new Set(otherRecords.map((r) => r.groupId).filter((id) => currentRecordGroups.has(id))),
  ];
  const selfSettlements = (
    await Promise.all(
      bothRecordGroups.map(async (groupId) => {
        const data = await loadMergeData(db, groupId, otherId);
        return findSelfSettlements({ fromId: otherId, toId: currentId, ...data }).length;
      }),
    )
  ).reduce((sum, count) => sum + count, 0);

  const side = (
    u: NonNullable<typeof current>,
    records: unknown[],
    memberOf: unknown[],
    isCurrent: boolean,
  ): AccountMergeSide => ({
    userId: u.id,
    name: labelUser(u),
    photoUrl: u.avatarUrl,
    providers: [...new Set(u.identities.map((i) => i.provider))],
    groupCount: memberOf.length,
    recordCount: records.length,
    isCurrent,
  });

  return {
    accounts: [
      side(current, currentRecords, currentGroups, true),
      side(other, otherRecords, otherGroups, false),
    ],
    suggestedKeepId: suggestKeep(
      { ...current, recordCount: currentRecords.length },
      { ...other, recordCount: otherRecords.length },
    ),
    blocked: check.ok ? null : check.error,
    sharedGroups,
    totalGroups: new Set([...currentGroups, ...otherGroups].map((g) => g.groupId)).size,
    selfSettlements,
  };
}

export type AccountMergeResult =
  | {
      ok: true;
      keepName: string;
      absorbName: string;
      /** Per group: the records rewritten and the settlements that now read "A → A". */
      groups: { groupId: number; recordIds: number[]; selfSettlementIds: number[] }[];
    }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Folds `absorbId` into `keepId` across every group, inside the caller's transaction, then
 * deletes `absorbId`. Log and refresh chat messages after it commits.
 *
 * Every column that points at `users.id` is handled here. The ones that cascade
 * (`auth_identities`, `sessions`, `push_subscriptions`, `group_delete_requests`,
 * `user_beancount_configs`, `group_members`) are moved *before* the delete, or the cascade
 * would silently drop the person's logins, other devices' sign-ins and push, and a pending
 * group deletion. A membership row keeps its own `push_muted`: where both were members, the
 * kept account's row (and its choice) survives.
 */
export async function mergeAccounts(
  tx: Tx,
  keepId: number,
  absorbId: number,
): Promise<AccountMergeResult> {
  // Both rows, in id order, so two merges touching the same account can't deadlock.
  await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [keepId, absorbId]))
    .orderBy(users.id)
    .for("update");

  // Sequential: these share the transaction's one connection.
  const keep = await loadAccount(tx, keepId);
  const absorb = await loadAccount(tx, absorbId);
  if (!keep || !absorb) return { ok: false, status: 404, error: "帳號不存在。" };
  const check = validateAccountMerge(keep, absorb);
  if (!check.ok) return { ok: false, status: 409, error: check.error };

  // Groups where the absorbed account has records, even ones it's no longer a member of.
  const absorbRecords = await recordGroups(tx, absorbId);
  const keepMembership = await memberGroups(tx, keepId);
  const absorbMembership = await memberGroups(tx, absorbId);
  const groupIds = [
    ...new Set([...absorbRecords.map((r) => r.groupId), ...absorbMembership.map((m) => m.groupId)]),
  ].sort((a, b) => a - b);

  const results: Extract<AccountMergeResult, { ok: true }>["groups"] = [];
  for (const groupId of groupIds) {
    const data = await loadMergeData(tx, groupId, absorbId, { lock: true });
    const plan = planMerge({ fromId: absorbId, toId: keepId, ...data });
    await applyMergePlan(tx, plan, keepId);
    results.push({
      groupId,
      recordIds: plan.recordIds,
      selfSettlementIds: findSelfSettlements({ fromId: absorbId, toId: keepId, ...data }),
    });
  }

  const membership = planMembership(keepMembership, absorbMembership);
  if (membership.repoint.length > 0) {
    await tx
      .update(groupMembers)
      .set({ userId: keepId })
      .where(
        and(eq(groupMembers.userId, absorbId), inArray(groupMembers.groupId, membership.repoint)),
      );
  }
  if (membership.activate.length > 0) {
    await tx
      .update(groupMembers)
      .set({ status: "active" })
      .where(
        and(eq(groupMembers.userId, keepId), inArray(groupMembers.groupId, membership.activate)),
      );
  }
  if (membership.drop.length > 0) {
    await tx
      .delete(groupMembers)
      .where(
        and(eq(groupMembers.userId, absorbId), inArray(groupMembers.groupId, membership.drop)),
      );
  }

  const keepConfigs = await tx
    .select({ id: userBeancountConfigs.id, groupId: userBeancountConfigs.groupId })
    .from(userBeancountConfigs)
    .where(eq(userBeancountConfigs.userId, keepId));
  const absorbConfigs = await tx
    .select({ id: userBeancountConfigs.id, groupId: userBeancountConfigs.groupId })
    .from(userBeancountConfigs)
    .where(eq(userBeancountConfigs.userId, absorbId));
  const configs = planBeancountConfigs(keepConfigs, absorbConfigs);
  if (configs.drop.length > 0) {
    await tx.delete(userBeancountConfigs).where(inArray(userBeancountConfigs.id, configs.drop));
  }
  if (configs.repoint.length > 0) {
    await tx
      .update(userBeancountConfigs)
      .set({ userId: keepId })
      .where(inArray(userBeancountConfigs.id, configs.repoint));
  }
  await repointUserReferences(tx, absorbId, keepId);
  await tx
    .update(groupDeleteRequests)
    .set({ requestedBy: keepId })
    .where(eq(groupDeleteRequests.requestedBy, absorbId));
  // Both ways of signing in now reach the kept account, and other devices stay signed in.
  await tx
    .update(authIdentities)
    .set({ userId: keepId })
    .where(eq(authIdentities.userId, absorbId));
  await tx.update(sessions).set({ userId: keepId }).where(eq(sessions.userId, absorbId));
  // A device that had push on for either account keeps receiving it.
  await tx
    .update(pushSubscriptions)
    .set({ userId: keepId })
    .where(eq(pushSubscriptions.userId, absorbId));
  // MCP connections follow the person; otherwise the cascade would revoke them silently.
  await tx
    .update(mcpConnections)
    .set({ userId: keepId })
    .where(eq(mcpConnections.userId, absorbId));

  // telegram_id is unique: clear it on the absorbed row before the kept row takes it.
  const fill = mergedProfileFields(keep, absorb);
  if (fill.telegramId !== undefined) {
    await tx.update(users).set({ telegramId: null }).where(eq(users.id, absorbId));
  }
  if (Object.keys(fill).length > 0) {
    await tx
      .update(users)
      .set({ ...fill, updatedAt: new Date() })
      .where(eq(users.id, keepId));
  }
  await tx.delete(users).where(eq(users.id, absorbId));

  return {
    ok: true,
    keepName: labelUser(keep),
    absorbName: labelUser(absorb),
    groups: results,
  };
}
