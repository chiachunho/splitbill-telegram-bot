import { describe, expect, it } from "vitest";

import { resolveMember } from "@/lib/mcp/names";

const m = (
  id: number,
  displayName: string | null,
  firstName: string,
  username: string | null = null,
  lastName: string | null = null,
) => ({
  id,
  displayName,
  firstName,
  lastName,
  username,
});

const members = [
  m(1, "阿華", "Hua", "hua_tw"),
  m(2, "Jenny", "Jennifer", "jen"),
  m(3, "Alex", "Alex", null, "Chen"),
  m(4, "Alex", "Alexander", null, "Wu"),
];

describe("resolveMember", () => {
  it("matches display name, provider name and username, ignoring case, width and @", () => {
    expect(resolveMember("阿華", members)).toMatchObject({ ok: true, member: { id: 1 } });
    expect(resolveMember("jenny", members)).toMatchObject({ ok: true, member: { id: 2 } });
    expect(resolveMember("Jennifer", members)).toMatchObject({ ok: true, member: { id: 2 } });
    expect(resolveMember("@HUA_TW", members)).toMatchObject({ ok: true, member: { id: 1 } });
    expect(resolveMember("ＪＥＮＮＹ", members)).toMatchObject({ ok: true, member: { id: 2 } });
  });

  it("does not guess from a prefix", () => {
    const r = resolveMember("Jen", members);
    expect(r).toMatchObject({ ok: true }); // "jen" is Jenny's exact username
    const r2 = resolveMember("Jenn", members);
    expect(r2).toMatchObject({ ok: false, code: "member_not_found" });
  });

  it("lists every candidate when nothing matches", () => {
    const r = resolveMember("Bob", members);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates.map((c) => c.memberId)).toEqual([1, 2, 3, 4]);
  });

  it("reports ambiguity with only the tied members", () => {
    const r = resolveMember("alex", members);
    expect(r).toMatchObject({ ok: false, code: "member_ambiguous" });
    if (!r.ok) expect(r.candidates.map((c) => c.memberId)).toEqual([3, 4]);
  });

  it("a memberId skips matching, and an unknown id is not found", () => {
    expect(resolveMember(4, members)).toMatchObject({ ok: true, member: { id: 4 } });
    expect(resolveMember(99, members)).toMatchObject({ ok: false, code: "member_not_found" });
  });

  it("an empty name matches nobody", () => {
    expect(resolveMember("  ", members)).toMatchObject({ ok: false, code: "member_not_found" });
  });
});
