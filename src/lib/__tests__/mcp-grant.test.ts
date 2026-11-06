import { describe, expect, it } from "vitest";

import { assertGrant, grantCovers, type Grant } from "@/lib/mcp/grant";
import { ForbiddenError } from "@/lib/auth/errors";

const grant = (over: Partial<Grant> = {}): Grant => ({
  connectionId: 1,
  access: "write",
  allGroups: false,
  groupIds: [10],
  ...over,
});

describe("assertGrant", () => {
  it("allows a listed group, read and write", () => {
    expect(() => assertGrant(grant(), 10, "read")).not.toThrow();
    expect(() => assertGrant(grant(), 10, "write")).not.toThrow();
  });

  it("refuses a group outside the list", () => {
    expect(() => assertGrant(grant(), 11, "read")).toThrow(ForbiddenError);
  });

  it("allGroups covers any group, including ones joined later", () => {
    expect(grantCovers(grant({ allGroups: true, groupIds: [] }), 999)).toBe(true);
  });

  it("a read token can't write, even in a listed group", () => {
    const g = grant({ access: "read" });
    expect(() => assertGrant(g, 10, "read")).not.toThrow();
    expect(() => assertGrant(g, 10, "write")).toThrow(ForbiddenError);
  });
});
