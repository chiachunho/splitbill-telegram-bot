import { isDay, snapshotDay } from "@/lib/day";
import { labelUser } from "@/lib/label";
import { fmtGrouped } from "@/lib/money";
import { type NoticeLeg, type NoticeRecord } from "@/lib/record-notice";

/**
 * What the audit log stores and how a change is described.
 *
 * Pure — no DB, no network — so both front ends and the API render a change the
 * same way and the whole thing is unit-testable. The DB side lives in
 * `src/lib/record-mutation.ts`.
 */

export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "rate_locked"
  | "member_joined"
  | "invite_reset"
  | "chat_linked"
  | "chat_unlinked"
  | "timezone_changed"
  | "member_claimed"
  | "account_merged";
export type AuditSource = "bot" | "app" | "mcp";

/**
 * The stored before/after shape.
 *
 * Deliberately `NoticeRecord` plus a few columns rather than a new type: that
 * shape already *is* this app's canonical "what this record is" summary — it is
 * what the group-chat message renders from — so the log can't drift into
 * describing records differently from every other surface. The extra fields are
 * the ones a reader of the log needs and a chat message doesn't.
 *
 * Names are captured as they were at the time. That is the point of a log: it
 * says what the record looked like then, not what it would look like now.
 */
export type RecordSnapshot = NoticeRecord & {
  /** `YYYY-MM-DD`. Rows logged before the date column hold an ISO instant instead; read
   *  either with `snapshotDay`. */
  spentAt: string;
  fxRate: number | null;
  fxQuote: string | null;
  /** How many receipt photos were attached. */
  receipts: number;
};

/**
 * A group-level rate lock, logged once instead of once per rewritten row.
 *
 * `expenseIds` / `settlementIds` are what make it visible from a single
 * record's history: without them a record's timeline would show an
 * unexplained jump in its converted amount, with nothing in the log to
 * account for it. See `rateLockTouches`.
 */
export type RateLockPayload = {
  kind: "rateLock";
  base: string;
  quote: string;
  /** NULL when the group rate was deleted rather than changed. */
  rate: number | null;
  expenseIds: number[];
  settlementIds: number[];
};

export function isRateLockPayload(value: unknown): value is RateLockPayload {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "rateLock"
  );
}

/**
 * Group-level membership events (`recordType: 'group'`, no record id).
 * `memberJoined` names who invited the member, captured as the name was then;
 * `chatLinked` names the Telegram chat a web group was bound to, `chatUnlinked` the chat it was
 * detached from (the title as it was then, since the group no longer has the chat to ask);
 * `timezoneChanged` records the group's time zone before and after; `memberClaimed` records a placeholder being merged into a real account. Its
 * `recordIds` are the records that were rewritten, so a single record's history
 * can explain why a name on it changed (`loadRecordHistory` matches them with `@>`).
 */
export type GroupEventPayload =
  | { kind: "memberJoined"; inviterId: number; inviterName: string }
  | { kind: "inviteReset" }
  | { kind: "chatLinked"; chatTitle: string }
  | { kind: "chatUnlinked"; chatTitle: string }
  | { kind: "timezoneChanged"; from: string; to: string }
  | {
      kind: "memberClaimed";
      placeholderId: number;
      placeholderName: string;
      claimerId: number;
      claimerName: string;
      recordIds: number[];
    }
  | {
      kind: "accountMerged";
      absorbedId: number;
      absorbedName: string;
      keptId: number;
      keptName: string;
      recordIds: number[];
    };

export function isGroupEventPayload(value: unknown): value is GroupEventPayload {
  const kind =
    typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
  return (
    kind === "memberJoined" ||
    kind === "inviteReset" ||
    kind === "chatLinked" ||
    kind === "chatUnlinked" ||
    kind === "timezoneChanged" ||
    kind === "memberClaimed" ||
    kind === "accountMerged"
  );
}

/** Whether a rate lock rewrote this particular record. */
export function rateLockTouches(payload: RateLockPayload, recordId: number): boolean {
  return payload.expenseIds.includes(recordId) || payload.settlementIds.includes(recordId);
}

/* ── diffing ──────────────────────────────────────────────────────────── */

export type ChangedField = {
  key: "amount" | "currency" | "description" | "spentAt" | "payers" | "splits" | "fx" | "receipts";
  /** Traditional-Chinese label, shared by both front ends so they can't drift. */
  label: string;
  before: string;
  after: string;
  /** Extra context when before/after alone is too coarse, e.g. "移除 張大文". */
  detail?: string;
};

const NONE = "（無）";

function legNames(legs: NoticeLeg[]): string[] {
  return legs.map((l) => labelUser(l.user));
}

function legIds(legs: NoticeLeg[]): number[] {
  return legs.map((l) => l.user.userId);
}

/** "移除 A、B" / "新增 C" / both — or undefined when the same people are listed. */
function membershipDetail(before: NoticeLeg[], after: NoticeLeg[]): string | undefined {
  const beforeIds = new Set(legIds(before));
  const afterIds = new Set(legIds(after));

  const removed = before.filter((l) => !afterIds.has(l.user.userId));
  const added = after.filter((l) => !beforeIds.has(l.user.userId));
  if (removed.length === 0 && added.length === 0) return undefined;

  const parts: string[] = [];
  if (removed.length > 0) parts.push(`移除 ${legNames(removed).join("、")}`);
  if (added.length > 0) parts.push(`新增 ${legNames(added).join("、")}`);
  return parts.join(" · ");
}

/** True when the same people appear on both sides, in any order. */
function sameMembership(a: NoticeLeg[], b: NoticeLeg[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(legIds(a));
  return b.every((l) => ids.has(l.user.userId));
}

/** Proportions are compared, not amounts, so 1,000 → 100 doesn't read as three changes. */
const SHARE_EPSILON = 0.005;

/**
 * Whether the legs still divide the record the same way.
 *
 * Changing the total rescales every payer contribution and every share, so a
 * naive amount comparison reports 付款人 and 分帳 as having changed too — three
 * rows, all restating the one edit, and two of them rendering as "X → X"
 * because the names never moved. Comparing each person's *proportion* of the
 * total separates "the total moved" from "the split moved".
 */
function distributionUnchanged(
  before: NoticeLeg[],
  after: NoticeLeg[],
  beforeTotal: number,
  afterTotal: number,
): boolean {
  if (!sameMembership(before, after)) return false;

  const share = (leg: NoticeLeg, total: number) => (total > 0 ? leg.amount / total : leg.amount);
  const afterById = new Map(after.map((l) => [l.user.userId, l] as const));

  return before.every((b) => {
    const a = afterById.get(b.user.userId);
    return (
      a !== undefined && Math.abs(share(b, beforeTotal) - share(a, afterTotal)) <= SHARE_EPSILON
    );
  });
}

/** "Alice 600、Bob 400" — names alone cannot show a redistribution. */
function legAmounts(legs: NoticeLeg[]): string {
  return legs.map((l) => `${labelUser(l.user)} ${fmtGrouped(l.amount)}`).join("、");
}

function dateLabel(spentAt: string): string {
  const day = snapshotDay(spentAt);
  if (!isDay(day)) return spentAt;
  const [y, m, d] = day.split("-").map(Number);
  return `${y}/${m}/${d}`;
}

function fxLabel(rate: number | null, quote: string | null): string {
  return rate != null && quote != null ? `${rate} ${quote}` : "自動";
}

/**
 * What changed between two snapshots, in display order.
 *
 * Amount and currency stay separate rows on purpose — collapsing them into one
 * "1,200 TWD → 1,200 JPY" line reads as if the number changed when only the
 * currency did. Each row states exactly one fact.
 *
 * An empty result means nothing a reader would care about moved, and the caller
 * should not write a log row at all: a PATCH that rewrites identical payers and
 * splits is not an edit anyone needs to see.
 */
export function diffRecords(before: RecordSnapshot, after: RecordSnapshot): ChangedField[] {
  const out: ChangedField[] = [];

  if (before.amount !== after.amount) {
    out.push({
      key: "amount",
      label: "金額",
      before: fmtGrouped(before.amount),
      after: fmtGrouped(after.amount),
    });
  }

  if (before.currency !== after.currency) {
    out.push({
      key: "currency",
      label: "幣別",
      before: before.currency,
      after: after.currency,
    });
  }

  if ((before.description ?? "") !== (after.description ?? "")) {
    out.push({
      key: "description",
      label: "說明",
      before: before.description || NONE,
      after: after.description || NONE,
    });
  }

  if (dateLabel(before.spentAt) !== dateLabel(after.spentAt)) {
    out.push({
      key: "spentAt",
      label: "日期",
      before: dateLabel(before.spentAt),
      after: dateLabel(after.spentAt),
    });
  }

  if (!distributionUnchanged(before.payers, after.payers, before.amount, after.amount)) {
    // Who paid, when the people changed; how much each paid, when they didn't.
    const detail = membershipDetail(before.payers, after.payers);
    out.push({
      key: "payers",
      label: "付款人",
      before: detail ? legNames(before.payers).join("、") : legAmounts(before.payers),
      after: detail ? legNames(after.payers).join("、") : legAmounts(after.payers),
      ...(detail ? { detail } : {}),
    });
  }

  if (!distributionUnchanged(before.splits, after.splits, before.amount, after.amount)) {
    const detail = membershipDetail(before.splits, after.splits);
    out.push({
      key: "splits",
      label: "分帳",
      before: detail ? `${before.splits.length} 人` : legAmounts(before.splits),
      after: detail ? `${after.splits.length} 人` : legAmounts(after.splits),
      ...(detail ? { detail } : {}),
    });
  }

  if (before.fxRate !== after.fxRate || before.fxQuote !== after.fxQuote) {
    out.push({
      key: "fx",
      label: "匯率",
      before: fxLabel(before.fxRate, before.fxQuote),
      after: fxLabel(after.fxRate, after.fxQuote),
    });
  }

  if (before.receipts !== after.receipts) {
    out.push({
      key: "receipts",
      label: "收據",
      before: `${before.receipts} 張`,
      after: `${after.receipts} 張`,
    });
  }

  // Last line of defence: a row whose two sides read the same tells the reader
  // nothing, however it was arrived at. Better to drop the row — and if that
  // empties the diff, to write no log entry at all.
  return out.filter((c) => c.before !== c.after || c.detail !== undefined);
}

/* ── row wording ──────────────────────────────────────────────────────── */

/** What `changeHeading` and `rateLockImpact` need — `ActivityEntry` satisfies it. */
export type HeadingInput = {
  action: AuditAction;
  recordType: string;
  recordLabel?: string | null;
  changes?: ChangedField[];
  rateLock?: { base: string; rate: number | null } | null;
  groupEvent?: {
    inviterName?: string;
    chatTitle?: string;
    claimedName?: string;
    claimedCount?: number;
    /** Set when someone other than the claimer did the merge. */
    claimerName?: string;
    timezoneFrom?: string;
    timezoneTo?: string;
  } | null;
};

/**
 * The bold first line of a row.
 *
 * Lives here rather than in the component so it can be tested: this is the
 * line that read "改了金額、付款人、分帳" for what was a single amount edit,
 * and nothing would have caught it.
 *
 * `withRecordName` is true on the group feed, where a row has to say which
 * record it is about. On a record's own page that is already the page title,
 * so the heading spends itself naming the fields that moved instead.
 */
export function changeHeading(entry: HeadingInput, withRecordName: boolean): string {
  const kind = entry.recordType === "settlement" ? "還款" : "支出";
  const named = entry.recordLabel?.trim() || kind;

  switch (entry.action) {
    case "created":
      return withRecordName ? `新增了 ${named}` : `新增了${kind}`;
    case "deleted":
      return withRecordName ? `刪除了 ${named}` : `刪除了${kind}`;
    case "member_joined":
      return entry.groupEvent?.inviterName
        ? `加入了群組（由 ${entry.groupEvent.inviterName} 邀請）`
        : "加入了群組";
    case "invite_reset":
      return "重設了邀請碼";
    case "chat_linked":
      return entry.groupEvent?.chatTitle
        ? `綁定了 Telegram 群組（${entry.groupEvent.chatTitle}）`
        : "綁定了 Telegram 群組";
    case "chat_unlinked":
      return entry.groupEvent?.chatTitle
        ? `解除了與 Telegram 群組「${entry.groupEvent.chatTitle}」的綁定`
        : "解除了與 Telegram 群組的綁定";
    case "timezone_changed":
      return entry.groupEvent?.timezoneFrom && entry.groupEvent.timezoneTo
        ? `把群組時區從 ${entry.groupEvent.timezoneFrom} 改成 ${entry.groupEvent.timezoneTo}`
        : "改了群組時區";
    case "member_claimed":
      if (!entry.groupEvent?.claimedName) return "認領了無帳號成員";
      return entry.groupEvent.claimerName
        ? `把 ${entry.groupEvent.claimedName} 合併到 ${entry.groupEvent.claimerName}`
        : `認領了 ${entry.groupEvent.claimedName}`;
    case "account_merged":
      return entry.groupEvent?.claimedName
        ? `把帳號 ${entry.groupEvent.claimedName} 併入自己的帳號`
        : "合併了兩個帳號";
    case "rate_locked": {
      if (!entry.rateLock) return "鎖定了匯率";
      const rate = entry.rateLock.rate != null ? ` ${entry.rateLock.rate}` : "";
      return `鎖定了 ${entry.rateLock.base} 匯率${rate}`;
    }
    default: {
      if (withRecordName) return `改了 ${named}`;
      const fields = entry.changes?.map((c) => c.label).join("、");
      return `改了${fields || "內容"}`;
    }
  }
}

/** "影響 12 筆支出 · 3 筆轉帳" — a kind with nothing in it is left out entirely. */
export function rateLockImpact(counts: { expenses: number; settlements: number }): string {
  const parts = [
    counts.expenses > 0 ? `${counts.expenses} 筆支出` : null,
    counts.settlements > 0 ? `${counts.settlements} 筆轉帳` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `影響 ${parts.join(" · ")}` : "沒有影響既有紀錄";
}

/**
 * One-line summary of a record, for the rows that have no before/after to show:
 * "created" lists what was entered, "deleted" what went.
 */
export function summariseRecord(snapshot: RecordSnapshot): string {
  const money = `${fmtGrouped(snapshot.amount)} ${snapshot.currency}`;
  if (snapshot.type === "settlement") {
    const from = snapshot.payers[0];
    const to = snapshot.splits[0];
    if (!from || !to) return money;
    return `${money} · ${labelUser(from.user)} → ${labelUser(to.user)}`;
  }
  return `${money} · ${snapshot.splits.length} 人分帳`;
}
