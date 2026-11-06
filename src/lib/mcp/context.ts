import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { groupMembers, groups, users } from "@/db/schema";
import { assertGrant, type McpAccess } from "@/lib/mcp/grant";
import { assertGroupMember } from "@/lib/auth";
import type { McpAuth } from "@/lib/auth/mcp";
import { NotFoundError } from "@/lib/auth/errors";
import { memberLabels } from "@/lib/label";
import { enforceMcpRateLimit } from "@/lib/rate-limit";

export type McpMember = {
  id: number;
  displayName: string | null;
  firstName: string;
  lastName: string | null;
  username: string | null;
  placeholder: boolean;
  active: boolean;
};

export async function loadMembers(groupId: number): Promise<McpMember[]> {
  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
      placeholderGroupId: users.placeholderGroupId,
      status: groupMembers.status,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.joinedAt), asc(users.id));
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    firstName: r.firstName,
    lastName: r.lastName,
    username: r.username,
    placeholder: r.placeholderGroupId != null,
    active: r.status === "active",
  }));
}

/** Counts the call, then checks membership and the grant — in that order, every call. */
export async function openGroup(
  auth: McpAuth,
  groupId: number,
  need: McpAccess,
  opts: { countAs?: McpAccess } = {},
) {
  await enforceMcpRateLimit(auth.grant.connectionId, opts.countAs ?? need);
  await assertGroupMember(auth.user.id, groupId);
  assertGrant(auth.grant, groupId, need);
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) throw new NotFoundError("group not found");
  const members = await loadMembers(groupId);
  return { group, members, labels: memberLabels(members) };
}
