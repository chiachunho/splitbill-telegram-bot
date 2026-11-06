import type { Pool } from "@neondatabase/serverless";
import type { APIRequestContext } from "@playwright/test";

import { generateToken, hashToken, tokenDisplayPrefix } from "../src/lib/mcp/token";
import { expect, test } from "./fixtures";

/**
 * The MCP server (`/api/mcp`, issue #149) against the real database. Tokens are inserted
 * with a known plaintext; calls are plain JSON-RPC over HTTP with no cookie, so only the
 * bearer token is authenticating.
 */
async function mkToken(
  dbPool: Pool,
  userId: number,
  opts: { access?: "read" | "write"; groupIds?: number[]; allGroups?: boolean } = {},
) {
  const token = generateToken();
  const { rows } = await dbPool.query(
    `INSERT INTO mcp_connections (user_id, kind, name, token_hash, token_prefix, access, all_groups, group_ids)
     VALUES ($1,'token','E2E token',$2,$3,$4,$5,$6) RETURNING id`,
    [
      userId,
      hashToken(token),
      tokenDisplayPrefix(token),
      opts.access ?? "write",
      opts.allGroups ?? false,
      opts.groupIds ?? [],
    ],
  );
  return { token, id: rows[0].id as number };
}

let rpcId = 0;
async function rpc(request: APIRequestContext, token: string, method: string, params?: object) {
  return request.post("/api/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    data: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
async function call(request: APIRequestContext, token: string, name: string, args: object) {
  const res = await rpc(request, token, "tools/call", { name, arguments: args });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { result: ToolResult }).result;
}

test.describe("MCP server", () => {
  test("tools/list shows the core tools", async ({ request, seeded, dbPool }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const res = await rpc(request, token, "tools/list");
    expect(res.status()).toBe(200);
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        "add_expense",
        "add_settlement",
        "get_balance",
        "get_group",
        "get_record",
        "list_groups",
        "list_records",
      ].sort(),
    );
  });

  test("an expense added by name changes the balance, and the same key does not repeat it", async ({
    request,
    seeded,
    dbPool,
  }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const args = {
      groupId: seeded.groupId,
      amount: "1,000",
      description: "E2E MCP dinner",
      split: { type: "equal", among: [seeded.partnerName, "me"] },
      idempotencyKey: `e2e-${seeded.groupId}-1`,
    };
    const first = await call(request, token, "add_expense", args);
    expect(first.structuredContent).toMatchObject({ status: "created" });
    const recordId = first.structuredContent!.recordId as number;

    const again = await call(request, token, "add_expense", args);
    expect(again.structuredContent).toMatchObject({ status: "duplicate", recordId });

    const { rows } = await dbPool.query(
      "SELECT count(*)::int AS n FROM expenses WHERE group_id=$1 AND description=$2",
      [seeded.groupId, "E2E MCP dinner"],
    );
    expect(rows[0].n).toBe(1);

    const bal = await call(request, token, "get_balance", { groupId: seeded.groupId });
    const mine = (bal.structuredContent!.balances as { memberId: number; amount: number }[]).find(
      (b) => b.memberId === seeded.userId,
    );
    // Seeded: I paid 300 and owe 150 (+150). Now I paid 1000 and owe 500 (+500 more).
    expect(mine?.amount).toBe(650);

    const audit = await dbPool.query(
      "SELECT source, mcp_connection_id FROM record_audit_log WHERE record_id=$1",
      [recordId],
    );
    expect(audit.rows[0].source).toBe("mcp");
    expect(audit.rows[0].mcp_connection_id).not.toBeNull();
  });

  test("an unknown name is refused with candidates and writes nothing", async ({
    request,
    seeded,
    dbPool,
  }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const res = await call(request, token, "add_expense", {
      groupId: seeded.groupId,
      amount: 50,
      split: { type: "equal", among: ["Nobody Here"] },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent!.error.code).toBe("member_not_found");
    expect(res.structuredContent!.error.candidates.length).toBe(2);
  });

  test("an identical expense within minutes is held back as a possible duplicate", async ({
    request,
    seeded,
    dbPool,
  }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const args = { groupId: seeded.groupId, amount: 77, description: "E2E dup" };
    const first = await call(request, token, "add_expense", args);
    expect(first.structuredContent!.status).toBe("created");
    const second = await call(request, token, "add_expense", args);
    expect(second.structuredContent).toMatchObject({
      status: "possible_duplicate",
      possibleDuplicateOf: first.structuredContent!.recordId,
    });
    const forced = await call(request, token, "add_expense", { ...args, allowDuplicate: true });
    expect(forced.structuredContent!.status).toBe("created");
  });

  test("a read-only token can read but not write", async ({ request, seeded, dbPool }) => {
    const { token } = await mkToken(dbPool, seeded.userId, {
      access: "read",
      groupIds: [seeded.groupId],
    });
    const read = await call(request, token, "get_group", { groupId: seeded.groupId });
    expect(read.isError).toBeFalsy();
    const write = await call(request, token, "add_expense", {
      groupId: seeded.groupId,
      amount: 10,
    });
    expect(write.isError).toBe(true);
    expect(write.structuredContent!.error.code).toBe("forbidden");
  });

  test("a group outside the token's scope, or one the user is not in, is refused", async ({
    request,
    seeded,
    dbPool,
  }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const foreign = await call(request, token, "get_group", { groupId: seeded.foreignGroupId });
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent!.error.code).toBe("forbidden");

    // All groups still stops at the user's own membership.
    const wide = await mkToken(dbPool, seeded.userId, { allGroups: true });
    const notMember = await call(request, wide.token, "get_group", {
      groupId: seeded.foreignGroupId,
    });
    expect(notMember.isError).toBe(true);
    expect(notMember.structuredContent!.error.code).toBe("forbidden");

    const list = await call(request, token, "list_groups", {});
    expect(list.structuredContent!.groups.map((g: { groupId: number }) => g.groupId)).toEqual([
      seeded.groupId,
    ]);
  });

  test("a revoked or expired token is a 401, and so is no token", async ({
    request,
    seeded,
    dbPool,
  }) => {
    const revoked = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    expect((await rpc(request, revoked.token, "tools/list")).status()).toBe(200);
    await dbPool.query("UPDATE mcp_connections SET revoked_at = now() WHERE id=$1", [revoked.id]);
    expect((await rpc(request, revoked.token, "tools/list")).status()).toBe(401);

    const expired = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    await dbPool.query(
      "UPDATE mcp_connections SET expires_at = now() - interval '1 minute' WHERE id=$1",
      [expired.id],
    );
    expect((await rpc(request, expired.token, "tools/list")).status()).toBe(401);

    const none = await request.post("/api/mcp", {
      headers: { accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(none.status()).toBe(401);
  });

  test("a token does not work on the REST API", async ({ request, seeded, dbPool }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const res = await request.get(`/api/groups/${seeded.groupId}/balance`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(401);
  });

  test("a settlement is recorded with a name, and from must differ from to", async ({
    request,
    seeded,
    dbPool,
  }) => {
    const { token } = await mkToken(dbPool, seeded.userId, { groupIds: [seeded.groupId] });
    const same = await call(request, token, "add_settlement", {
      groupId: seeded.groupId,
      to: "me",
      amount: 20,
    });
    expect(same.isError).toBe(true);

    const ok = await call(request, token, "add_settlement", {
      groupId: seeded.groupId,
      from: seeded.partnerName,
      to: "me",
      amount: 20,
    });
    expect(ok.structuredContent).toMatchObject({ status: "created" });
    const rec = await call(request, token, "get_record", {
      groupId: seeded.groupId,
      recordId: ok.structuredContent!.recordId,
    });
    expect(rec.structuredContent!.record.type).toBe("settlement");
  });

  test("tokens can be created, listed and revoked through the account API", async ({
    authedPage,
    seeded,
    request,
  }) => {
    const api = authedPage.request;
    const created = await api.post("/api/me/mcp-connections", {
      data: { name: "E2E laptop", access: "read", allGroups: false, groupIds: [seeded.groupId] },
    });
    expect(created.status()).toBe(201);
    const { connection, token } = (await created.json()) as {
      connection: { id: number; tokenHash?: string };
      token: string;
    };
    expect(token).toMatch(/^sbk_/);
    expect(connection.tokenHash).toBeUndefined();

    const listed = (await (await api.get("/api/me/mcp-connections")).json()) as {
      connections: { id: number; name: string }[];
    };
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed.connections.some((c) => c.id === connection.id)).toBe(true);
    expect((await rpc(request, token, "tools/list")).status()).toBe(200);

    // A group the user isn't in can't be put in a token's scope.
    const bad = await api.post("/api/me/mcp-connections", {
      data: { name: "x", access: "read", allGroups: false, groupIds: [seeded.foreignGroupId] },
    });
    expect(bad.status()).toBe(400);

    expect((await api.delete(`/api/me/mcp-connections/${connection.id}`)).status()).toBe(200);
    expect((await rpc(request, token, "tools/list")).status()).toBe(401);
    expect((await api.delete(`/api/me/mcp-connections/${connection.id}`)).status()).toBe(404);
  });
});
