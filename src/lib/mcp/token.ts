import crypto from "node:crypto";

/**
 * Personal MCP tokens (issue #149): `sbk_` + 32 random bytes in base64url. Made, shown
 * once and hashed here; `getMcpAuth` parses and hashes with the same functions, so the
 * two ends can't drift. A fast hash is enough: the token is 256 random bits, not a password.
 */
export const TOKEN_PREFIX = "sbk_";
const TOKEN_RE = /^sbk_[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** What the list shows so a person can tell tokens apart: `sbk_` and the next 4 characters. */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 4);
}

/** The token in an `Authorization: Bearer sbk_…` header, or null for anything else. */
export function parseBearerToken(header: string | null): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  const token = m?.[1];
  return token && TOKEN_RE.test(token) ? token : null;
}
