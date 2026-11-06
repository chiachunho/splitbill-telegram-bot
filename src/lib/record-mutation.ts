import { type Api } from "grammy";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { expenses, recordAuditLog } from "@/db/schema";
import {
  deleterOf,
  loadNoticeRecord,
  markNoticeDeleted,
  rememberNoticeMessage,
  sendRecordNotice,
  updateRecordNotice,
  type LoadedNotice,
} from "@/lib/notify";
import { queueRecordPush } from "@/lib/push";
import {
  diffRecords,
  type AuditSource,
  type GroupEventPayload,
  type RateLockPayload,
  type RecordSnapshot,
} from "@/lib/record-audit";

/**
 * The single way a record is created, changed or deleted.
 *
 * Every mutation site goes through here, and that is the whole design. The
 * fifteen write points are spread across six API route handlers and seven bot
 * callbacks; a separate `logAudit()` bolted on beside each of them would be
 * forgotten somewhere, and a missing audit row is invisible — exactly the kind
 * of silent drift CLAUDE.md's sharing rule exists to prevent.
 *
 * So logging is fused to the thing every one of those sites *already* cannot
 * skip: keeping the record's group-chat message in sync. Forget to route a
 * mutation through here and the Telegram message stops matching the record,
 * which someone notices the same day. The log can't rot on its own.
 *
 * `actor` is a required argument for the same reason — the compiler asks "who
 * did this?" at every call site, and there is no default that could quietly be
 * wrong.
 *
 * Push notifications (issue #67) hang off the same three calls, for the same
 * reason: a nudge to the people a change touches must not depend on each mutation
 * site remembering to send it. `queueRecordPush` runs after the response and
 * swallows its own errors.
 *
 * Errors from the chat side are swallowed by `notify.ts`. Errors from the log
 * write are swallowed here: an audit row is worth a lot, but not worth failing
 * a save the user already believes succeeded.
 */

export type Actor = {
  userId: number;
  source: AuditSource;
  /** The MCP connection that wrote this, when `source` is `"mcp"`. */
  mcpConnectionId?: number;
};

/**
 * Passing `api` asks this layer to send or edit the record's group message —
 * that is every API route handler, none of which has a message of its own.
 *
 * Passing `null` says the caller owns that message and will render it itself.
 * The bot's panel buttons re-render the card in `adjust` / `who` / `shares`
 * mode, which this layer must not flatten back to `default` mid-interaction,
 * and `/add` posts the card it just built. **Only the message handling
 * differs — the log is written either way**, which is the point: there is no
 * call shape that logs nothing.
 */
type MaybeApi = Api | null;

/** The open transaction handed to a mutation callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeLog(entry: {
  groupId: number;
  recordId: number | null;
  recordType: string;
  action: string;
  actor: Actor;
  before: RecordSnapshot | null;
  after: RecordSnapshot | RateLockPayload | GroupEventPayload | null;
}): Promise<void> {
  try {
    await db.insert(recordAuditLog).values({
      groupId: entry.groupId,
      recordId: entry.recordId,
      recordType: entry.recordType,
      action: entry.action,
      actorId: entry.actor.userId,
      source: entry.actor.source,
      mcpConnectionId: entry.actor.mcpConnectionId ?? null,
      before: entry.before,
      after: entry.after,
    });
  } catch (err) {
    console.error("[audit] failed to write log entry:", err);
  }
}

/**
 * Logs a freshly created record and puts its message in the group.
 *
 * With `api === null` the caller has already posted the message and only needs
 * it bound to the record — that is `/add`, which builds and sends the card
 * itself so a bot-created expense never gets a duplicate.
 */
export async function logCreated(
  api: MaybeApi,
  recordId: number,
  actor: Actor,
  opts: { messageId?: number } = {},
): Promise<void> {
  const loaded = await loadNoticeRecord(recordId);
  if (loaded) {
    await writeLog({
      groupId: loaded.groupId,
      recordId,
      recordType: loaded.record.type,
      action: "created",
      actor,
      before: null,
      after: loaded.record,
    });
    queueRecordPush({
      action: "created",
      groupId: loaded.groupId,
      recordId,
      before: null,
      after: loaded.record,
      creatorId: loaded.creator?.userId ?? null,
      actor,
    });
  }

  if (api) {
    await sendRecordNotice(api, recordId);
    return;
  }
  if (opts.messageId != null) await rememberNoticeMessage(recordId, opts.messageId);
}

/**
 * Runs `mutate`, logs what it actually changed, and refreshes the group message.
 *
 * The before/after pair is loaded around the mutation, so nothing has to
 * describe its own edit — a caller that rewrites five columns and a caller that
 * flips one produce the same kind of row. When the diff is empty no row is
 * written: the expense PATCH replaces payers and splits wholesale on every
 * save, so an identical re-save is not an edit anyone needs to read about.
 *
 * Returns whatever `mutate` returns.
 */
export async function logUpdated<T>(
  api: MaybeApi,
  recordId: number,
  actor: Actor,
  mutate: (tx: Tx) => Promise<T>,
): Promise<T> {
  // Both snapshots and the write share one transaction. Read outside it and two
  // people saving the same record at once can each pick up the other's values
  // as their own "after" — an audit log that misattributes changes is worse
  // than no audit log, since it reads as authoritative.
  const { result, before, after } = await db.transaction(async (tx) => {
    // Serialise writers on the record's row before anything is read or deleted.
    // Without this, two overlapping edits that each delete-then-insert the same
    // child rows (say, two 💳 誰付 taps) can both survive: under READ COMMITTED,
    // the second DELETE cannot see the first one's inserts, so each leaves its own
    // payer at the full amount and the payers sum to twice the total. Now the
    // second transaction waits here and then reads the first one's committed rows.
    await tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(eq(expenses.id, recordId))
      .for("update");
    const before = await loadNoticeRecord(recordId, tx);
    const result = await mutate(tx);
    const after = await loadNoticeRecord(recordId, tx);
    return { result, before, after };
  });

  // Written after the commit, deliberately: an insert that fails inside the
  // transaction would poison it and roll back the user's save.
  if (before && after && diffRecords(before.record, after.record).length > 0) {
    await writeLog({
      groupId: after.groupId,
      recordId,
      recordType: after.record.type,
      action: "updated",
      actor,
      before: before.record,
      after: after.record,
    });
    queueRecordPush({
      action: "updated",
      groupId: after.groupId,
      recordId,
      before: before.record,
      after: after.record,
      creatorId: after.creator?.userId ?? null,
      actor,
    });
  }

  if (api) await updateRecordNotice(api, recordId);
  return result;
}

/**
 * Runs `del`, logs what went, and leaves the tombstone message behind.
 *
 * The snapshot is taken before the row disappears — which is the same
 * requirement the group message already had, and the reason these two
 * responsibilities belong in one place rather than two.
 */
export async function logDeleted(
  api: MaybeApi,
  recordId: number,
  actor: Actor,
  deleter: Parameters<typeof deleterOf>[0],
  del: (tx: Tx) => Promise<void>,
): Promise<LoadedNotice | null> {
  // Snapshot and delete in one transaction: the record is gone afterwards, so
  // a concurrent edit landing between the two would be recorded as what was
  // deleted, which is the one thing this row exists to get right.
  const before = await db.transaction(async (tx) => {
    const snapshot = await loadNoticeRecord(recordId, tx);
    await del(tx);
    return snapshot;
  });

  if (before) {
    await writeLog({
      groupId: before.groupId,
      recordId,
      recordType: before.record.type,
      action: "deleted",
      actor,
      before: before.record,
      after: null,
    });
    queueRecordPush({
      action: "deleted",
      groupId: before.groupId,
      recordId,
      before: before.record,
      after: null,
      creatorId: before.creator?.userId ?? null,
      actor,
    });
  }

  if (api) await markNoticeDeleted(api, before, deleterOf(deleter));
  return before;
}

/**
 * Logs a group rate lock: one row for a change that rewrote many records.
 *
 * Deliberately not one `updated` row per touched record — the user performed a
 * single group-level action, and fanning it out would bury a day's real edits
 * under fifty identical lines. The affected ids ride along in the payload so a
 * single record's history can still explain why its converted amount moved.
 */
export async function logRateLock(
  groupId: number,
  actor: Actor,
  payload: RateLockPayload,
): Promise<void> {
  if (payload.expenseIds.length === 0 && payload.settlementIds.length === 0) return;
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "rate_locked",
    actor,
    before: null,
    after: payload,
  });
}

/** Logs someone joining through an invite; `inviter` is who made the code. */
export async function logMemberJoined(
  groupId: number,
  actor: Actor,
  inviter: { id: number; name: string },
): Promise<void> {
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "member_joined",
    actor,
    before: null,
    after: { kind: "memberJoined", inviterId: inviter.id, inviterName: inviter.name },
  });
}

/** Logs the invite code being replaced (the old one stops working). */
export async function logInviteReset(groupId: number, actor: Actor): Promise<void> {
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "invite_reset",
    actor,
    before: null,
    after: { kind: "inviteReset" },
  });
}

/** Logs a web group being bound to a Telegram chat; the title is captured as it was then. */
export async function logChatLinked(
  groupId: number,
  actor: Actor,
  chatTitle: string,
): Promise<void> {
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "chat_linked",
    actor,
    before: null,
    after: { kind: "chatLinked", chatTitle },
  });
}

/** Logs a group being detached from its Telegram chat; the title is captured as it was then. */
export async function logChatUnlinked(
  groupId: number,
  actor: Actor,
  chatTitle: string,
): Promise<void> {
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "chat_unlinked",
    actor,
    before: null,
    after: { kind: "chatUnlinked", chatTitle },
  });
}

/**
 * Logs the group's time zone being changed. Both names are kept as they were then.
 * Nothing is written when the zone did not actually change.
 */
export async function logTimezoneChanged(
  groupId: number,
  actor: Actor,
  change: { from: string; to: string },
): Promise<void> {
  if (change.from === change.to) return;
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "timezone_changed",
    actor,
    before: null,
    after: { kind: "timezoneChanged", from: change.from, to: change.to },
  });
}

/**
 * Logs a placeholder being merged into a real account. Call it after the merge
 * transaction commits; `recordIds` are every expense and settlement rewritten.
 */
export async function logMemberClaimed(
  groupId: number,
  actor: Actor,
  claim: {
    placeholderId: number;
    placeholderName: string;
    claimerId: number;
    claimerName: string;
    recordIds: number[];
  },
): Promise<void> {
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "member_claimed",
    actor,
    before: null,
    after: {
      kind: "memberClaimed",
      placeholderId: claim.placeholderId,
      placeholderName: claim.placeholderName,
      claimerId: claim.claimerId,
      claimerName: claim.claimerName,
      recordIds: claim.recordIds,
    },
  });
}

/**
 * Logs two accounts becoming one, once per group the absorbed account was in. Call it after
 * the merge transaction commits; `recordIds` are that group's rewritten records.
 */
export async function logAccountMerged(
  groupId: number,
  actor: Actor,
  merge: {
    absorbedId: number;
    absorbedName: string;
    keptId: number;
    keptName: string;
    recordIds: number[];
  },
): Promise<void> {
  await writeLog({
    groupId,
    recordId: null,
    recordType: "group",
    action: "account_merged",
    actor,
    before: null,
    after: { kind: "accountMerged", ...merge },
  });
}
