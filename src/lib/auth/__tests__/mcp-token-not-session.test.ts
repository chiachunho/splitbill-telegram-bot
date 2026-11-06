import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("database touched");
      },
    },
  ),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { getAuth } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/auth/errors";
import { generateToken } from "@/lib/mcp/token";

describe("getAuth", () => {
  it("does not accept an MCP token, so REST stays closed to agents", async () => {
    const req = new Request("http://localhost/api/groups/1/balance", {
      headers: { authorization: `Bearer ${generateToken()}` },
    });
    await expect(getAuth(req)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
