import { describe, expect, it } from "vitest";

import { parseMcpAmount } from "@/lib/mcp/amount";

describe("parseMcpAmount", () => {
  it("takes numbers and the /add grammar", () => {
    expect(parseMcpAmount(12.5)).toMatchObject({ ok: true, amount: 12.5, currency: null });
    expect(parseMcpAmount("1,200")).toMatchObject({ ok: true, amount: 1200 });
    expect(parseMcpAmount("3k")).toMatchObject({ ok: true, amount: 3000 });
    expect(parseMcpAmount("150+200")).toMatchObject({ ok: true, amount: 350 });
    expect(parseMcpAmount("€50")).toMatchObject({ ok: true, amount: 50, currency: "EUR" });
    expect(parseMcpAmount("300 USD")).toMatchObject({ ok: true, amount: 300, currency: "USD" });
  });
  it("refuses leftovers, zero and nonsense", () => {
    expect(parseMcpAmount("3杯咖啡")).toMatchObject({ ok: false });
    expect(parseMcpAmount("300 lunch")).toMatchObject({ ok: false });
    expect(parseMcpAmount("abc")).toMatchObject({ ok: false });
    expect(parseMcpAmount(0)).toMatchObject({ ok: false });
    expect(parseMcpAmount(-5)).toMatchObject({ ok: false });
    expect(parseMcpAmount(NaN)).toMatchObject({ ok: false });
  });
});
