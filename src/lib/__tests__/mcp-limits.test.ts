import { describe, expect, it } from "vitest";

import { idempotencyCutoff, duplicateSince, IDEMPOTENCY_TTL_MS } from "@/lib/mcp/idempotency";
import { decide, RATE_RULES, windowStart } from "@/lib/rate-limits";

describe("MCP rate limits", () => {
  it("allows 60 writes and refuses the 61st, with the full window as the wait", () => {
    const r = RATE_RULES.mcpWrite;
    expect(decide([{ rule: r, count: 60 }])).toEqual({ ok: true });
    expect(decide([{ rule: r, count: 61 }])).toEqual({
      ok: false,
      retryAfter: 3600,
      firstRefusal: true,
    });
    expect(decide([{ rule: r, count: 62 }])).toMatchObject({ ok: false, firstRefusal: false });
  });
  it("reads have their own, larger bucket", () => {
    expect(RATE_RULES.mcpRead.limit).toBe(600);
    expect(RATE_RULES.mcpRead.name).not.toBe(RATE_RULES.mcpWrite.name);
    expect(decide([{ rule: RATE_RULES.mcpRead, count: 61 }])).toEqual({ ok: true });
  });
  it("windows are hourly", () => {
    const at = new Date("2026-11-06T10:42:13Z");
    expect(windowStart(at, RATE_RULES.mcpWrite.windowMs).toISOString()).toBe(
      "2026-11-06T10:00:00.000Z",
    );
  });
});

describe("MCP idempotency windows", () => {
  it("keys live 24 hours; duplicates are looked for over 10 minutes", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(now.getTime() - idempotencyCutoff(now).getTime()).toBe(IDEMPOTENCY_TTL_MS);
    expect(now.getTime() - duplicateSince(now).getTime()).toBe(10 * 60 * 1000);
  });
});
