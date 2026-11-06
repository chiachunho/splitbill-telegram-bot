import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { mcpConnections } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { withAuth } from "@/lib/auth/route";
import { requireId } from "@/lib/route-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revokes a connection: it stops working at once, and its row stays for the audit log. */
export const DELETE = withAuth(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await getAuth(req);
    const id = requireId((await params).id, "connection id");
    const revoked = await db
      .update(mcpConnections)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpConnections.id, id),
          eq(mcpConnections.userId, auth.user.id),
          isNull(mcpConnections.revokedAt),
        ),
      )
      .returning({ id: mcpConnections.id });
    if (revoked.length === 0) {
      return NextResponse.json({ error: "connection not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  },
);
