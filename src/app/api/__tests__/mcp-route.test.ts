import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/mcp` without a database: a call without a valid token is refused before anything
 * is read, and a signed-in `tools/list` is answered by the real SDK transport. The tool
 * bodies are database work and are covered in e2e/mcp.spec.ts.
 */

const state = vi.hoisted(() => ({ dbTouched: false }));

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        state.dbTouched = true;
        throw new Error("database touched");
      },
    },
  ),
}));

vi.mock("@/lib/rate-limit", () => ({ enforceMcpRateLimit: vi.fn() }));

import { UnauthorizedError } from "@/lib/auth/errors";

const mcpAuth = vi.hoisted(() => ({ authed: false }));
vi.mock("@/lib/auth/mcp", () => ({
  getMcpAuth: vi.fn(async () => {
    if (!mcpAuth.authed) throw new UnauthorizedError("invalid, revoked or expired token");
    return {
      user: { id: 1 },
      grant: { connectionId: 1, access: "write", allGroups: true, groupIds: [] },
    };
  }),
}));

import { DELETE, GET, POST } from "@/app/api/mcp/route";

const rpc = (body: unknown) =>
  new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer sbk_x",
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.dbTouched = false;
  mcpAuth.authed = false;
});

describe("/api/mcp", () => {
  it("answers 401 with a challenge when the token is no good, before reading anything", async () => {
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(state.dbTouched).toBe(false);
  });

  it("is POST only", async () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });

  it("lists the core tools, with write tools marked as such", async () => {
    mcpAuth.authed = true;
    const res = await POST(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    const tools = new Map(json.result.tools.map((t) => [t.name, t]));
    expect([...tools.keys()].sort()).toEqual(
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
    expect(tools.get("list_groups")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("add_expense")?.annotations?.readOnlyHint).toBe(false);
    expect(state.dbTouched).toBe(false);
  });
});
