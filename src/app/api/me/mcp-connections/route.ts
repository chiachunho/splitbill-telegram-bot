import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { mcpConnections, groupMembers } from "@/db/schema";
import { createConnectionSchema, MAX_MCP_CONNECTIONS } from "@/lib/mcp/connection-input";
import { generateToken, hashToken, tokenDisplayPrefix } from "@/lib/mcp/token";
import { getAuth } from "@/lib/auth";
import { BadRequestError } from "@/lib/auth/errors";
import { withAuth } from "@/lib/auth/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publicColumns = {
  id: mcpConnections.id,
  kind: mcpConnections.kind,
  name: mcpConnections.name,
  tokenPrefix: mcpConnections.tokenPrefix,
  access: mcpConnections.access,
  allGroups: mcpConnections.allGroups,
  groupIds: mcpConnections.groupIds,
  lastUsedAt: mcpConnections.lastUsedAt,
  expiresAt: mcpConnections.expiresAt,
  revokedAt: mcpConnections.revokedAt,
  createdAt: mcpConnections.createdAt,
};

/** The caller's connections, newest first, never the hash. */
export const GET = withAuth(async (req: Request) => {
  const auth = await getAuth(req);
  const rows = await db
    .select(publicColumns)
    .from(mcpConnections)
    .where(eq(mcpConnections.userId, auth.user.id))
    .orderBy(desc(mcpConnections.createdAt));
  return NextResponse.json({ connections: rows });
});

/** Creates a personal token. The plaintext is in this response and nowhere else, ever. */
export const POST = withAuth(async (req: Request) => {
  const auth = await getAuth(req);
  const parsed = createConnectionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const groupIds = [...new Set(input.groupIds)];
  if (!input.allGroups) {
    const mine = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(and(eq(groupMembers.userId, auth.user.id), inArray(groupMembers.groupId, groupIds)));
    if (mine.length !== groupIds.length) throw new BadRequestError("not a member of every group");
  }

  const live = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.userId, auth.user.id), isNull(mcpConnections.revokedAt)));
  if (live.length >= MAX_MCP_CONNECTIONS) {
    throw new BadRequestError(`at most ${MAX_MCP_CONNECTIONS} active connections`);
  }

  const token = generateToken();
  const [row] = await db
    .insert(mcpConnections)
    .values({
      userId: auth.user.id,
      kind: "token",
      name: input.name,
      tokenHash: hashToken(token),
      tokenPrefix: tokenDisplayPrefix(token),
      access: input.access,
      allGroups: input.allGroups,
      groupIds: input.allGroups ? [] : groupIds,
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null,
    })
    .returning(publicColumns);
  return NextResponse.json({ connection: row, token }, { status: 201 });
});
