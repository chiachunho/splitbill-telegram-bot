import { describe, expect, it } from "vitest";

import { generateToken, hashToken, parseBearerToken, tokenDisplayPrefix } from "@/lib/mcp/token";

describe("MCP tokens", () => {
  it("a generated token is read back from a Bearer header", () => {
    const t = generateToken();
    expect(parseBearerToken(`Bearer ${t}`)).toBe(t);
    expect(parseBearerToken(`bearer   ${t}`)).toBe(t);
  });

  it("is unique and 256 bits", () => {
    const a = generateToken();
    expect(a).not.toBe(generateToken());
    expect(a).toMatch(/^sbk_[A-Za-z0-9_-]{43}$/);
  });

  it("rejects anything that is not an sbk token", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("tma abc")).toBeNull();
    expect(parseBearerToken("Bearer sbk_short")).toBeNull();
    expect(parseBearerToken("Bearer eyJhbGciOi.jwt.token")).toBeNull();
  });

  it("hashes deterministically, and never to the token itself", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).not.toBe(hashToken(generateToken()));
  });

  it("shows only a short prefix", () => {
    const t = generateToken();
    expect(tokenDisplayPrefix(t)).toBe(t.slice(0, 8));
    expect(tokenDisplayPrefix(t)).toMatch(/^sbk_/);
  });
});
