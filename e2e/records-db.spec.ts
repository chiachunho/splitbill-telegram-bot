import { expect, test } from "./fixtures";
import { addExpense, addSettlement, editExpense, legs, type ExpenseBody } from "./helpers";

/**
 * The record write layer (`src/lib/records`, issue #148) against the real database. It moved
 * out of four route handlers without changing behaviour, so these cases pin what a second
 * caller (the MCP server) must not change: the order the checks answer in, the rows a refused
 * write leaves behind, the audit trail, and the dormant FX pin.
 */
const GHOST_ID = 2_000_000_000; // a user id that is in no group

function body(me: number, partner: number, over: Partial<ExpenseBody> = {}): ExpenseBody {
  return {
    amount: 100,
    shareType: "equal",
    payers: [{ payerId: me, amount: 100 }],
    splits: [
      { debtorId: me, amount: 50 },
      { debtorId: partner, amount: 50 },
    ],
    ...over,
  };
}

test.describe("Record writes (database)", () => {
  test("a payer outside the group is refused and writes nothing", async ({
    authedPage,
    seeded,
    dbPool,
  }) => {
    const { request } = authedPage;
    const before = await dbPool.query("SELECT count(*)::int AS n FROM expenses WHERE group_id=$1", [
      seeded.groupId,
    ]);

    const res = await request.post(`/api/groups/${seeded.groupId}/expenses`, {
      data: {
        currency: "TWD",
        description: "E2E outsider",
        spentAt: "2026-01-01",
        ...body(seeded.userId, seeded.partnerId, {
          payers: [{ payerId: seeded.outsiderId, amount: 100 }],
        }),
      },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: `users not in group: ${seeded.outsiderId}` });

    const after = await dbPool.query("SELECT count(*)::int AS n FROM expenses WHERE group_id=$1", [
      seeded.groupId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("editing a missing record answers 404 before it checks the people", async ({
    authedPage,
    seeded,
  }) => {
    const { request } = authedPage;
    const res = await editExpense(
      request,
      seeded.groupId,
      GHOST_ID,
      body(seeded.userId, seeded.partnerId, {
        payers: [{ payerId: seeded.outsiderId, amount: 100 }],
      }),
    );
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: "expense not found" });
  });

  test("a settlement is checked from≠to, then people, then existence", async ({
    authedPage,
    seeded,
  }) => {
    const { request } = authedPage;
    const url = `/api/groups/${seeded.groupId}/settlements/${GHOST_ID}`;
    const patch = (from: number, to: number) =>
      request.patch(url, { data: { fromUserId: from, toUserId: to, amount: 10, currency: "TWD" } });

    const same = await patch(seeded.userId, seeded.userId);
    expect(same.status()).toBe(400);
    expect(await same.json()).toEqual({ error: "from and to must differ" });

    const outsider = await patch(seeded.userId, seeded.outsiderId);
    expect(outsider.status()).toBe(400);

    const missing = await patch(seeded.userId, seeded.partnerId);
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });
  });

  test("each kind is deleted only through its own route, and its legs go with it", async ({
    authedPage,
    seeded,
    dbPool,
  }) => {
    const { request } = authedPage;
    const g = seeded.groupId;
    const expenseId = await addExpense(request, g, body(seeded.userId, seeded.partnerId));
    const settlementId = await addSettlement(request, g, seeded.partnerId, seeded.userId, 20);

    expect((await request.delete(`/api/groups/${g}/settlements/${expenseId}`)).status()).toBe(404);
    expect((await request.delete(`/api/groups/${g}/expenses/${settlementId}`)).status()).toBe(404);

    expect((await request.delete(`/api/groups/${g}/expenses/${expenseId}`)).status()).toBe(200);
    expect((await request.delete(`/api/groups/${g}/settlements/${settlementId}`)).status()).toBe(
      200,
    );

    for (const id of [expenseId, settlementId]) {
      const gone = await legs(dbPool, id);
      expect(gone.payers).toEqual([]);
      expect(gone.splits).toEqual([]);
    }
  });

  test("create, edit and delete are logged from the app with no MCP connection", async ({
    authedPage,
    seeded,
    dbPool,
  }) => {
    const { request } = authedPage;
    const g = seeded.groupId;
    const id = await addExpense(request, g, body(seeded.userId, seeded.partnerId));
    const edit = await editExpense(
      request,
      g,
      id,
      body(seeded.userId, seeded.partnerId, {
        amount: 120,
        payers: [{ payerId: seeded.userId, amount: 120 }],
        splits: [
          { debtorId: seeded.userId, amount: 60 },
          { debtorId: seeded.partnerId, amount: 60 },
        ],
      }),
    );
    expect(edit.status()).toBe(200);
    expect((await request.delete(`/api/groups/${g}/expenses/${id}`)).status()).toBe(200);

    const rows = await dbPool.query(
      "SELECT action, source, actor_id, mcp_connection_id FROM record_audit_log WHERE record_id=$1 ORDER BY id",
      [id],
    );
    expect(rows.rows.map((r) => r.action)).toEqual(["created", "updated", "deleted"]);
    for (const r of rows.rows) {
      expect(r.source).toBe("app");
      expect(r.actor_id).toBe(seeded.userId);
      expect(r.mcp_connection_id).toBeNull();
    }
  });

  test("a blank rate keeps a dormant pin unless the currency changes", async ({
    authedPage,
    seeded,
    dbPool,
  }) => {
    const { request } = authedPage;
    const g = seeded.groupId;
    const id = await addExpense(
      request,
      g,
      body(seeded.userId, seeded.partnerId, { currency: "USD", fxRate: 30 }),
    );
    // Simulate the group default having changed since: the pin now names another currency.
    await dbPool.query("UPDATE expenses SET fx_quote='JPY' WHERE id=$1", [id]);
    const pin = async () =>
      (await dbPool.query("SELECT fx_rate, fx_quote FROM expenses WHERE id=$1", [id])).rows[0];

    const sameCurrency = await editExpense(
      request,
      g,
      id,
      body(seeded.userId, seeded.partnerId, { currency: "USD" }),
    );
    expect(sameCurrency.status(), await sameCurrency.text()).toBe(200);
    expect((await pin()).fx_quote).toBe("JPY");

    const otherCurrency = await editExpense(
      request,
      g,
      id,
      body(seeded.userId, seeded.partnerId, { currency: "EUR" }),
    );
    expect(otherCurrency.status(), await otherCurrency.text()).toBe(200);
    expect(await pin()).toEqual({ fx_rate: null, fx_quote: null });
  });
});
