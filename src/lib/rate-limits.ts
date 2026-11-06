/**
 * Rate limits on everything that resolves an invite code, and the pure decision of whether
 * a request is over them (issue #121). The counting itself is in `rate-limit.ts`.
 *
 * Windows are fixed (floored to `windowMs`), not sliding: one upsert per request is the
 * whole cost, and a burst straddling a boundary getting up to 2× the limit doesn't matter
 * against a 50-bit code. Every attempt counts, valid code or not, and counting happens
 * before the lookup, so a refused request never reaches `group_invites`.
 *
 * The remaining wait is never shown to a person (page or bot): telling someone exactly when
 * the window resets helps a script time its next burst. `Retry-After` is sent, but as the
 * full window length rather than the time left, so it doesn't reveal the boundary either.
 */

const MINUTE = 60_000;

export type RateRule = {
  /** Key prefix in `rate_limit_hits`; the id that follows says whose counter it is. */
  name: string;
  /** Attempts allowed per window; the one after is refused. */
  limit: number;
  windowMs: number;
};

export const RATE_RULES = {
  /** Invite preview + accept share this bucket: a real join costs 2–4 hits. */
  inviteUser: { name: "invite:user", limit: 30, windowMs: 10 * MINUTE },
  /** Loose on purpose: an office or a carrier NAT shares one address, so does CI. */
  inviteIp: { name: "invite:ip", limit: 120, windowMs: 10 * MINUTE },
  /** Bot `/link`, by the sender's Telegram id. */
  linkSender: { name: "link:tg", limit: 10, windowMs: 10 * MINUTE },
  /** Bot `/link`, by chat, so a room of accounts can't multiply the sender limit. */
  linkChat: { name: "link:chat", limit: 20, windowMs: 10 * MINUTE },
  /** MCP tool calls per connection (issue #149): reads and writes are counted apart. */
  mcpRead: { name: "mcp:read", limit: 600, windowMs: 60 * MINUTE },
  mcpWrite: { name: "mcp:write", limit: 60, windowMs: 60 * MINUTE },
} as const satisfies Record<string, RateRule>;

/** What a refused request answers. Lives in DB-free code so the join page can match it. */
export const RATE_LIMITED = { status: 429, error: "嘗試太多次，請稍後再試" } as const;

/** Rows older than this are swept; well past the longest window. */
const SWEEP_AFTER_MS = 24 * 60 * MINUTE;

export function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/** `rate_limit_hits.key` for one rule and whoever it counts. */
export function rateKey(rule: RateRule, id: string | number): string {
  return `${rule.name}:${id}`;
}

export type RateHit = { rule: RateRule; count: number };

export type RateDecision =
  | { ok: true }
  | {
      ok: false;
      /** Seconds for `Retry-After`: the longest refusing window, never the time left. */
      retryAfter: number;
      /** This attempt is the first one refused in its window (for replying only once). */
      firstRefusal: boolean;
    };

/** Refused when any rule's count (this attempt included) is over its limit. */
export function decide(hits: RateHit[]): RateDecision {
  const over = hits.filter((h) => h.count > h.rule.limit);
  if (over.length === 0) return { ok: true };
  return {
    ok: false,
    retryAfter: Math.max(...over.map((h) => Math.ceil(h.rule.windowMs / 1000))),
    firstRefusal: over.some((h) => h.count === h.rule.limit + 1),
  };
}

/** Rows whose window started before this are dead and may be deleted. */
export function sweepBefore(now: Date): Date {
  return new Date(now.getTime() - SWEEP_AFTER_MS);
}

/**
 * The caller's address as Vercel reports it, or null (local dev, tests). Vercel overwrites
 * these headers at its edge, so a client can't pick its own; `x-vercel-forwarded-for` is
 * checked first because it is the one Vercel documents as never passed through from the
 * client. A comma list means proxies in front: the first entry is the client.
 */
export function clientIp(headers: Headers): string | null {
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const first = headers.get(name)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}
