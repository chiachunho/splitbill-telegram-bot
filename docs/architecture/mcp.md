# MCP server (issue #147, phase 1: issue #149)

`POST /api/mcp` is a sixth front end next to the REST API and the bot. It shares
`src/lib/records/` for writes (issue #148), so an agent's record gets the same audit row,
group message and push as any other.

## Transport

Stateless Streamable HTTP with the SDK's web-standard transport (`sessionIdGenerator:
undefined`, `enableJsonResponse: true`). A new `McpServer` is built per request
(`src/lib/mcp/server.ts`), closed over the caller's `McpAuth`. `GET` and `DELETE` answer
405: there is no session to stream to, and an open SSE stream would pin an invocation.

## Identity

`getMcpAuth` (`src/lib/auth/mcp.ts`) accepts only `Authorization: Bearer sbk_…`, hashes
it (`src/lib/mcp/token.ts`, sha256) and looks the hash up in `mcp_connections`. Revocation
and expiry are checked **every call**. A 401 carries `WWW-Authenticate: Bearer`.
**`getAuth` does not accept these tokens**, so REST stays closed to agents and a token can't
manage tokens (`mcp-token-not-session.test.ts`).

Every tool runs `openGroup` (`src/lib/mcp/context.ts`): count the call against the rate limit,
`assertGroupMember` (the owner's _current_ membership, so leaving a group ends the token's
access to it), then `assertGrant` (`src/lib/mcp/grant.ts`: the connection's group scope and
`read`/`write`). `all_groups` includes groups joined later.

## Connections

`mcp_connections` stores the hash and a display prefix, never the token. `POST
/api/me/mcp-connections` returns the plaintext once. `DELETE …/[id]` sets `revoked_at`; the
row stays so `record_audit_log.mcp_connection_id` (`ON DELETE SET NULL`) keeps a name. At
most 20 live connections per user. `mergeAccounts` moves `mcp_connections.user_id`.

## Tools

Read: `list_groups`, `get_group`, `get_balance`, `list_records`, `get_record`. Write:
`add_expense`, `add_settlement`. `update_record` / `delete_record` are phase 2.

- **Data twice, prose never.** Every result has `structuredContent` and the same data as a
  JSON text block in `content` (`src/lib/mcp/result.ts`), because some clients show a model
  only `content`; without it an error would read as a bare code and a list as a count. The
  first text block stays a fixed sentence of ids and numbers, so free text (descriptions,
  names) is only ever a string value inside the JSON, which the server `instructions` call
  data. The threat model adds no new source: any member can already write any description.
- **Names are matched exactly** (`src/lib/mcp/names.ts`: display name, Telegram name,
  username; NFKC, case-folded, `@` ignored; no prefix matching), only among the group's
  members. No match or several → `member_not_found` / `member_ambiguous` with candidates and
  nothing written. A `memberId` skips matching; `"me"` is the caller.
- `add_expense` amounts accept the bot's `/add` grammar (`parseMcpAmount`); splits are built
  by the pure `buildExpenseInput` and still pass `expenseInputSchema`, so sums can't drift from
  the forms. `dryRun` previews and counts against the read bucket.
- **Idempotency** (`mcp_idempotency`, `UNIQUE(connection_id, key)`, 24 h): the insert is the
  lock. A repeat returns `status: "duplicate"` with the original `recordId`; a repeat while
  the first call runs is `in_progress`. A failed or held call releases its key.
- **Possible duplicates**: same group, amount, currency and sole payer within 10 minutes is
  _not written_; the result is `status: "possible_duplicate"` with `possibleDuplicateOf`.
  Resend with `allowDuplicate: true` to record it anyway.
- **Rate limits** per connection, in Postgres (`rate_limit_hits`): 600 reads and 60 writes an
  hour, fixed windows. A refusal is a `rate_limited` tool error; `retryAfterSeconds` is the
  full window, as with the invite limits.

## Testing

Pure parts are unit-tested (`mcp-*.test.ts`); `src/app/api/__tests__/mcp-route.test.ts`
drives the real SDK transport without a database; `e2e/mcp.spec.ts` covers the database work.
