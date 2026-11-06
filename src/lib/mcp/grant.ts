import { ForbiddenError } from "@/lib/auth/errors";

export type McpAccess = "read" | "write";

/** What a connection may touch, on top of the owner's own group membership. */
export type Grant = {
  connectionId: number;
  access: McpAccess;
  allGroups: boolean;
  groupIds: number[];
};

export function grantCovers(grant: Grant, groupId: number): boolean {
  return grant.allGroups || grant.groupIds.includes(groupId);
}

/** Throws unless the connection may use `groupId` with the needed access. */
export function assertGrant(grant: Grant, groupId: number, need: McpAccess): void {
  if (!grantCovers(grant, groupId))
    throw new ForbiddenError("this connection can't access that group");
  if (need === "write" && grant.access !== "write") {
    throw new ForbiddenError("this connection is read-only");
  }
}
