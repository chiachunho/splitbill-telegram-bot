# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Maintenance rule:** When implementing a feature that changes architecture, env vars, DB schema, or testing conventions, update this file in the same PR/commit. Feature design that is too detailed for this file lives in `docs/architecture/*.md`; when a change touches one of those features, update that file too and keep the short rule list here in step. Also check whether the public help site (`src/app/help/**`, see "Help site" below) needs updating — it describes user-visible behaviour, so a changed bot reply, button label, form field, or permission goes stale there silently if not updated in the same commit.

## Commands

```bash
pnpm dev            # Next.js dev server on http://localhost:3000
pnpm build          # Production build
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint (flat config, eslint.config.mjs)
pnpm format         # Prettier (writes)
pnpm format:check   # Prettier (read-only; what PR check runs — keep the tree formatted)

pnpm test           # Run all tests once (vitest)
pnpm test:watch     # Vitest watch mode
pnpm e2e            # Playwright E2E against $E2E_BASE_URL (see Testing)
# Run a single test file:
pnpm vitest run src/lib/__tests__/settlement.test.ts

pnpm db:migrate     # Apply pending data migrations from migrations/ (recorded in schema_migrations)
pnpm db:push        # Sync Drizzle schema to Neon (no migration files)
pnpm db:generate    # Generate migration SQL (not normally needed)
pnpm db:studio      # Drizzle Studio GUI
pnpm bot:set-webhook    # tsx scripts/set-webhook.ts <https-domain>
pnpm bot:set-commands   # tsx scripts/set-commands.ts (register the bot's slash-command menu)
pnpm check:page-pairs   # warn when a diff edits one Mini App / Web App page copy and not the other (advisory; vs origin/dev by default)

# One-time data migrations:
pnpm tsx scripts/migrate-payers.ts       # (run BEFORE db:push) populate expense_payers from expenses.payer_id
pnpm tsx scripts/migrate-settlements.ts  # (run BEFORE db:push) fold settlements into expenses(type='settlement'), then db:push drops the table
pnpm db:migrate-identities               # (run AFTER db:push) backfill auth_identities from users.telegramId
```

Package manager is **pnpm**. Do not use npm or yarn.

## Architecture

A single Next.js 15 (App Router) app serves six concerns simultaneously:

1. **Telegram Bot** — grammY webhook at `POST /api/telegram`
2. **Mini App frontend** — React pages at `/mini/**` (Telegram-embedded, `initData` auth)
3. **Web App frontend** — React pages at `/app/**` (standalone browser, Auth.js session-cookie auth) + `/login`
4. **REST API** — Next.js route handlers at `/api/**` (shared by both frontends)
5. **Help site** — public MDX pages at `/help/**` (no auth)
6. **MCP server** — `POST /api/mcp` for AI assistants (bearer-token auth; see "MCP server" below)

The Mini App and Web App share the same **lower-level building blocks** — `src/components/**`, `src/lib/**`, and the `/api/**` route handlers — and differ only in how auth/context is supplied (see API Auth and Web Auth below). **The top-level page bodies are shared too**, in `src/components/pages/**`. Each route's `src/app/mini/**/page.tsx` and `src/app/app/**/page.tsx` is a thin wrapper that passes in a `Platform`. The type is `src/components/pages/platform.ts`; each app implements it in its own module (`platform.mini.tsx`, `platform.web.tsx`), and a wrapper imports only its own, so a route's bundle never carries the other app's fetchers or Telegram code. The `Platform` holds everything that legitimately differs between the apps: the base path for links, the authenticated raw request, the viewer's self-photo hook, and the platform's chrome (header leading control, back navigation, the group-list header, the help row, the sign-out section, and where an unauthenticated viewer is sent, which a body acts on through `useLoginRedirect`: a 401 sends the web to `/login?next=…` and shows the Mini App its error; what counts as a 401 and where it leads live once in `src/lib/auth-redirect.ts`, used by both `useLoginRedirect` and the Web App's store-wide 401 handler). Platform differences belong in that object, so a change to a shared body reaches both apps by construction. `pnpm check:page-pairs` flags a diff that touched one copy and not the other; the `page-pairs` job in `pr-check.yml` posts the same result as an advisory PR comment (it never fails the check, since some one-sided edits are intentional). The pairs are derived from the path, so a new page needs no entry anywhere. Shared, testable logic should live in `src/lib/**` and be imported by both (see `src/lib/expense-view.ts`).

### What to share, and what to leave duplicated

**The test is not "is this written twice" — it is "when the copies drift, does anything fail loudly?"** Duplication that breaks a build or a test can wait; duplication that quietly produces a wrong result is what earns a shared module. Everything currently shared was collapsed for that reason, and each case names its own silent failure:

- **Both ends of a wire contract belong in the same file.** `src/lib/deep-link.ts` builds _and_ parses the `startapp` payload. When it was six builders and one parser, a mismatch didn't throw — the deep link just landed on the group list and nobody noticed for weeks. Anything with a producer and a consumer that must agree (a URL payload, a `callback_data` shape, a stored format) goes in one module, round-trip tested against itself rather than against hand-written strings.
- **A query shape whose omission degrades output instead of erroring.** `USER_COLUMNS` (`src/bot/profiles.ts`) exists because a select that forgets `telegramId` still succeeds — it just renders every mention as plain text.
- **One thing rendered by two renderers.** An expense card and a settlement notice draw the same 🔗 App 編輯 / 🗑 刪除 buttons, so `BTN` (`src/lib/buttons.ts`) owns the wording. Prose that _names_ a button interpolates the same constant, so `/help` can't start describing a button that was renamed.

**Leave it duplicated when sharing would cost more than the drift.** Three standing examples:

- The per-app files that are not page wrappers: the two `layout.tsx` files and the per-route `loading.tsx` skeletons. The layouts mount different providers (the Mini App loads the Telegram script and `TelegramApp`; the Web App mounts `AuthProvider mode="web"` with `WebStoreProvider`), so they cannot be one file. Each `loading.tsx` is a one-line render of a skeleton that already lives in `src/components/mini/skeletons.tsx`. The route-to-skeleton mapping is per-route content, and Next.js needs one `loading.tsx` per route segment, so sharing would remove no files. Drift there shows as a briefly wrong placeholder, not a wrong result. A change to one of these goes into both copies, and `pnpm check:page-pairs` warns when only one side changes.
- A callback toast with a **single** caller stays inline next to the condition it describes. `TOAST` in `src/lib/buttons.ts` only holds the ones with two or more callers; a message you have to open another file to read is worse than a repeated one.
- Not every repeated block is the same idea. Two functions that happen to look alike today, for unrelated reasons, will need to diverge tomorrow — and un-sharing is harder than sharing.

**Where it goes:** `src/lib/**` when the bot _and_ the API or a frontend both need it (that also keeps it pure and unit-testable — see `src/lib/expense-view.ts`, `src/lib/record-notice.ts`); `src/bot/**` when only the bot does. `src/lib` may import a leaf module from `src/bot` (`notify.ts` renders the expense card), but keep those leaves dependency-free so it never becomes a cycle.

**Route ids go through `requireId`** (`src/lib/route-params.ts`): a route segment or query id is read with `requireId(raw, "group id")`, which throws a `BadRequestError` (`src/lib/auth/errors.ts`) that `withAuth` answers as `400 invalid <label>`. It accepts only plain positive int4 digits; the `Number(x)` + `Number.isFinite` it replaced let `""`, `"1.5"` and ids past int4 through to Postgres. A new route that takes an id uses it instead of parsing by hand.

### Bot (`src/bot/`)

`src/bot/index.ts` exports a lazy singleton `getBot()` — the bot instance is not created until the first webhook hit, so `TELEGRAM_BOT_TOKEN` doesn't need to exist at build time. Middleware runs in registration order: `chatMigration` → `registerUser` → `trackMembership` → commands.

Two middleware layers auto-populate the DB:

- `registerUser` — upserts the `users` row for any message sender
- `trackMembership` — upserts the `group_members` row

#### Membership tracking is event-sourced, and cannot be backfilled

The Bot API has **no "list chat members" endpoint** (only `getChatMemberCount`, `getChatAdministrators`, and `getChatMember` for an id you already have), so `group_members` is assembled from whatever events happen to arrive. Four sources, in the order a person is most likely to hit them:

1. `registerUser` — the sender of any group message or callback query the bot actually receives, which under **privacy mode** (BotFather's default) is only slash commands, @mentions of the bot, and replies to the bot's own messages. So this is "anyone who has used the bot", _not_ "anyone who has talked in the group" — turning privacy mode off widens it to every message at the cost of the bot reading all group chat. Explicitly **not** `chat_member` updates: there `ctx.from` is whoever caused a status change, so seating them would add a lurker the moment they leave, or an admin for kicking someone. A spurious `group_members` row silently enlarges every equal split.
2. `trackMembership` on `new_chat_members` — the service message for someone added after the bot joined.
3. `trackMembership` on `chat_member` — every member status change, including invite-link joins; registers the _target_, and only on an absent → present transition. **Not delivered by default**: requires `chat_member` in `setWebhook`'s `allowed_updates` (`scripts/set-webhook.ts`) _and_ the bot being a group administrator.
4. `/join` (`src/bot/commands/join.ts`) and `forwardJoin` — manual, for people none of the above caught. **`/join` means "reply to their message, then type `/join`"** — that is the only form the help text, the usage message and the command menu mention. One person per reply, and privacy mode means it must be the `/join` command carrying the reply; a bare reply to another user never reaches the bot.

Two limits worth knowing before trying to "just add everyone":

- **Group creation emits no roster.** MTProto's `messageActionChatCreate` carries the initial participant list, but the Bot API flattens it to `Message.group_chat_created = true` and drops the users. Adding the bot while creating the group registers only the creator.
- **Mentioning can't identify anyone who has a username.** The two mention entity kinds are not equivalent: `text_mention` carries the full `User` object, while `mention` is the bare text `@handle` and there is no username → id lookup. Which one you get is not your choice — Telegram rewrites an @-list pick into a plain `@username` for any account that has one, leaving `text_mention` for the handle-less few. `src/lib/parseMentions.ts` splits them; `/join` still accepts `text_mention` because it costs nothing, but **does not advertise it**, since instructing users to "pick from the @ list" mostly sends them down a path that silently produces the unusable kind.

**`/join` deliberately does not resolve a typed-out `@handle` at all.** The only available guess is a match against `users.username`, which is neither unique nor live — it refreshes only when its owner next touches the bot — so a handle that has changed hands quietly seats the wrong person, and `getChatMember` can't catch it because the stale account is usually still in the chat. `parseMentions` still returns the handles, but purely so `/join` can tell the sender they did nothing and point at the reply form. Everything `/join` _does_ resolve goes through `getChatMember` before being seated, so it can't put a non-member into balances.

`/add` is a separate case and still accepts `@handle` (`src/lib/parseAdd.ts` → `resolveParticipants` in `src/bot/commands/add.ts`): its lookup is scoped to the group's **existing members** rather than all users, and a miss is a visible error rather than a silent wrong-person insert.

**Anything that seats someone in `group_members` from message content goes through `verifyInChat` (`src/bot/membership.ts`) first** — that's `/join`, and `/add`'s `text_mention` auto-registration. A `text_mention` entity survives copy/paste and forwarding, so it can name a person who was never in the chat, and only `getChatMember` can tell. Presence is three-valued: a transient API failure is indistinguishable from "never a member", so `unknown` does **not** seat.

**`getChatMember` is only trustworthy about other people when the bot is an administrator.** The Bot API guarantees it "for other users if the bot is an administrator in the chat"; a non-admin bot doesn't fail loudly, it can answer `left` for someone who really is a member — a confident wrong answer the call site can't detect. Since admin rights are optional for this bot (see `docs/DEPLOYMENT.md`), **any code that would refuse an action on a negative result must gate on `canVerifyMembership` first**. Both callers do, and both resolve the same way when the answer is untrustworthy: seat the person and rely on the user's intent. `/join`'s sender deliberately replied to someone and typed the command, and `/add`'s job is to record the expense — either signal beats an answer known to be unreliable. The spurious-member risk this guards against needs a copy-pasted or forwarded `text_mention`, which is far rarer than a group that never promoted the bot.

The reply form is the escape hatch from both limits, and its guards live in `replyTargetUser` (`src/lib/parseMentions.ts`): messages posted on behalf of a chat (anonymous admin, channel) have no personal account behind them and resolve to nothing, while a reply to a forwarded message resolves to the member who posted it here, not the original author.

`src/bot/handlers/chatMigration.ts` follows the chat-id rewrite when a basic group is upgraded to a supergroup (`migrate_to_chat_id` / `migrate_from_chat_id`), repointing `groups.(chat_type, chat_id)` so the existing members and expenses aren't orphaned under the dead id. It **must stay registered before `registerUser`**, which would otherwise upsert an empty duplicate group row under the new id first. When a duplicate does exist, whichever side has no expenses is folded into the other (`absorbGroup` carries over members and rates rather than letting the cascade drop them); if both hold expenses it logs and bails, since merging two real ledgers can't be done safely without a human.

#### `/add` and the expense card

**The text grammar is one line and that's on purpose: `/add <金額> [幣別] [說明] [@人 …]`.** Anything that would need memorising — who splits, per-person shares, changing the currency — is a _button_ on the expense card, not syntax. Don't grow the grammar; add a button.

- `src/lib/parseAdd.ts` — pure, unit-tested. Its job is **forgiveness**, not expressiveness: full-width characters, thousands separators (`1,200`), currency decorations (`$300`, `300元`, `€50`), `k`/`千`/`萬` multipliers and arithmetic (`150+200`, `(300+150)/3`) all parse. The arithmetic evaluator is a hand-written recursive-descent parser — **never `eval`**. Currency codes match `SUPPORTED_CURRENCIES` from `src/lib/zod.ts` and **nothing wider** — the bot must not create a record the Mini App form can't render or save (its `currency` is a `z.enum` over that same constant), and an unknown code makes `getRate` throw, which takes `/balance` and `/settle` down for the whole group. Amounts must end on whitespace, so `3杯咖啡` is rejected rather than read as 3. Error strings are plain text (no HTML) so the bot can echo user input without escaping.
- `src/bot/expenseCard.ts` — renders the card (text + keyboard) for any `CardMode` (`default` / `adjust` / `who` / `shares` / `currency`) and owns split writing. `writeSplits` stores `share_type='equal'` when every weight is 1 and `share_type='shares'` + `split_value` otherwise, so the Mini App form round-trips the same input.
- `src/bot/commands/expensePanel.ts` — the ⚙️ 調整 callbacks. **The panel keeps no state of its own** — every tap re-reads the expense from the DB and re-renders, so old cards keep working and concurrent taps converge. **Every callback that names an expense id must check it belongs to `ctx.dbGroup`** (`guard()`, plus `del_exp`, `upload_receipt` and the ForceReply replies): callback data is just a string the client sends, so an id on its own would reach across groups. That check is the bot-side counterpart of the REST layer's `assertGroupMember` — it is _not_ an ownership check, see below. `editMessageText` is `.catch()`-ed because re-selecting the current value renders identical output, which Telegram rejects.
- **`selective` targets nobody on a prompt that replies to the bot's own message** (Telegram only targets @mentioned users and the sender of the replied-to message), so every prompt raised from a callback mentions the requester in its text instead of setting `reply_to_message_id`.
- 👥 誰分 / ⚖️ 份數 recompute every share from weights, so they are only offered when `panelEditable` — i.e. every split is `equal` or `shares`.
- 💳 誰付 (`payer` mode, `exp:pay` / `exp:payt`) replaces the sole payer, so it is only offered when `payerEditable` — exactly one `expense_payers` row. Multi-payer expenses keep their per-person contributions and are edited in the App. A Mini-App `exact`/`percent`/`adjustment` split carries per-person intent the panel can't express, so the buttons are hidden and ✏️ 金額 rescales those amounts proportionally rather than flattening them.
- `src/bot/commands/add.ts` — the command, expense creation (`handleAddParsed`, also used by the photo-caption path in `receiptUpload.ts`) and the ForceReply replies. Parse failures reply _with_ a ForceReply prompt so a mistake is one tap from a retry.

#### Who may edit or delete a record

**Group membership is the only gate — there is no per-record owner lock, and adding one back is a decision to re-open, not a cleanup.** Any member can edit or delete any expense or settlement in a group they belong to; `assertGroupMember` is the whole check.

The case that decides it is "A recorded 800 as 300 and B is standing right there": with an owner lock B can only ask A to fix it, and A may be asleep, driving, or already out of the group. [Splitwise has taken the same position for over a decade](https://kb.splitwise.com/groups/can-i-prevent-group-members-from-changing-expenses-or-set-permissions) — _anyone involved should be able to correct mistakes and fix errors_ — against steady requests for permissions.

What replaces the lock is **attribution**:

- `expenses.createdBy` is returned by the expense and settlement endpoints — **including the `[expenseId]` / `[settlementId]` detail ones, which is where the edit forms actually read it from** — and the shared `ExpenseForm` / `SettlementForm` render 由 X 記錄 next to the destructive actions. `Initial.createdBy` is deliberately required rather than optional: it shipped optional once and the whole feature silently rendered nothing because only the list endpoints had been updated.
- Deleting someone else's record names them in the confirm dialog; the bot's 🗑 刪除 leaves a message saying what went, who recorded it and who removed it, so the chat itself is the audit trail.

- **Every change is logged** (`record_audit_log`), which is what makes "anyone may edit" answerable after the fact rather than just permissive. See "Audit log" below.

A **group-level** role (Settle Up's read-only vs edit) is the sane way to add restriction later if it's ever wanted — permission belonging to a person's standing in the group, not to who typed a given row. Don't reintroduce `createdBy` gating for it.

`group_members.status` (`active` / `inactive`) is unrelated: that controls _who is counted in a split_, not who may change records.

**404 on delete is now an ordinary outcome**, not an anomaly — two people can have the same record open. `deleteErrorMessage` (`src/lib/api-error.ts`) maps a status to a message and must never tell the user to retry something that cannot succeed.

#### Shared bot pieces

The inventory for the bot side of "What to share, and what to leave duplicated" above — each of these was collapsed because its duplicate failed silently, not loudly:

- `src/lib/deep-link.ts` — the `startapp` payload, **built and parsed here**.
  `groupLink` / `expenseLink` / `settlementLink` produce `group_<chatId>`,
  `…_exp_<id>` and `…_stl_<id>`; `parseStartParam` reads them back in
  `src/lib/auth/index.ts`. A builder that drifts from the parser doesn't throw —
  the link just lands on the group list and nobody notices. Round-trip tested.
- `src/lib/buttons.ts` — `BTN` (every inline-keyboard label) and `TOAST` (only
  the callback answers with more than one caller). Prose that _names_ a button
  interpolates `BTN` too, so `/help` can't start describing a button that was
  renamed. Single-caller toasts stay inline next to their condition.
- `src/bot/profiles.ts` — `USER_COLUMNS` (the select shape every bot query
  needs, so one can't forget `telegramId` and silently degrade its mentions to
  plain text) and `loadMentionMap`, shared by `/balance` and `/settle`.
- `src/bot/awaiting.ts` — the 24 h expiry shared by `add_awaiting` and
  `receipt_awaiting`.

### Mini App (`src/app/mini/`)

Telegram Mini App accessed via the bot's `web_app` button. All pages are client components that call the REST API through the RTK Query store (see "Client data layer" below), whose requests go through `tmaRawFetch` (`src/lib/tma-fetch.ts`), which attaches `Authorization: tma <initData>`.

**Before changing any Mini App UI, read [`docs/design-system.md`](docs/design-system.md).** It defines the design tokens and patterns — most importantly: radius has only two tiers (`rounded-2xl` containers / `rounded-lg` controls, both driven by `--radius`; never `rounded-xl` or arbitrary `rounded-[Npx]`), colors must go through the shadcn CSS vars (Telegram themes override them at runtime), financial figures use the `.num` utility, section headers use `.sect`, and loading states use the page-shaped skeletons in `components/mini/skeletons.tsx` (not spinners).

### Client data layer (`src/store/`)

All client reads and writes of `/api/**` go through **RTK Query** (`@reduxjs/toolkit` + `react-redux`); there is no other client-side store. `src/store/api.ts` is the one `createApi` for both apps, and **every endpoint is defined there** — a page never builds a URL or calls `fetch` for data the cache could hold.

- **Two stores, one api.** `makeStore(rawRequest, options)` (`src/store/store.ts`) is built per app: `StoreProvider` (`src/app/mini/`) with `tmaRawFetch`, `WebStoreProvider` (`src/app/app/`) with `webRawFetch` plus `onUnauthorized` (the 401 → `/login?next=…` redirect). The request reaches `apiBaseQuery` (`base-query.ts`) through the thunk `extra`, so the endpoint definitions are shared while a route's bundle carries only its own platform's fetcher. Don't import `tmaRawFetch` / `webRawFetch` from a shared component for data; the exception is what the cache has no use for (the receipt upload, the CSV download).
- **Errors** are `ApiError` (`src/lib/api-error.ts`): `{ status, data, message }`, where `message` is `${status} ${url}: ${body}` — the shape `isUnauthorizedError` has always read the status from, so a 401 is recognised whichever layer produced it. `status` is `0` when no response came. Use `apiErrorText` for the server's `{ error }` text, `apiErrorStatus` for a branch on status, `describeError` for the "無法載入" detail line; never `String(error)`, which prints `[object Object]`.
- **Cache invalidation is declared on the endpoint, not at the call site.** Tag types are listed at the top of `api.ts`; `ledgerTags(groupId)` is what any expense or settlement create/edit/delete touches (lists, balance, stats, activity) and `derivedFromRatesTags(groupId)` is what a rate or default-currency change touches (the same plus every record's detail, since converted amounts move). A new mutation names its tags there. Forms and pages must **not** keep their own list of keys to refresh: that list used to be copied into three components, and a key missing from one copy meant a page quietly showing numbers from before the edit. Group-scoped tags carry the group id as a _string_ (`String(groupId)`, since a page holds it as a string param and a form as a number); `Expense` / `Settlement` also use `<groupId>:<recordId>` for one record's detail.
- **A delete does not invalidate the record's own detail tag.** Its page is still mounted while the form navigates away, and refetching a record that no longer exists would flash a 404 on the way out.
- **Optimistic edits and cache writes** live in the second `injectEndpoints` block (so they can reach `baseApi.util` without the api naming its own type): the member status toggle and the default currency roll back on failure, the beancount PUT writes its response straight into the cache (the settings form's 已儲存 baseline is the server's copy), and `resetInvite` writes the new code into `getInvite` from its own response, since the old code is revoked the moment the server answers and must not stay copyable while the refetch runs (or after it fails).
- **Freshness** matches what the app had before RTK Query: `refetchOnMountOrArgChange: 5` shows the cached value and refetches behind it when it is more than 5 s old, and `keepUnusedDataFor: 300` keeps a left page's data for five minutes. `data` from a hook keeps the previous argument's result while a new one loads (the old `keepPreviousData`); use `currentData` when a decision must wait for the _current_ argument (`CustomRatesSection` does for the affected-record counts).
- **The activity feed and the expense list** are `infiniteQuery` endpoints (`getActivity`, `getExpenses`) with the previous page's `nextCursor` as the page param. Invalidating their tag refetches every loaded page, so an edit to a row on page 2 shows without the list resetting. See "Expense list pagination".
- Response types are shared in `src/lib/api-types.ts` (types only); pages used to each declare their own `MeResponse` / `MembersResponse` / `AvatarsResponse`, and the copies had drifted.
- **Testing**: `src/store/test-utils.tsx` has `fakeRequest(routes)` (a path → JSON map; an unlisted path answers 500 so a test can't pass on a request it never allowed; `Failure(status)` for errors) and `StoreWrapper`. Page tests render inside a `StoreWrapper` and `await` the data — it arrives asynchronously, unlike the old synchronous fallback. Cache behaviour (what a mutation refetches, rollbacks) is tested against the store directly in `src/store/__tests__/api.test.ts`.

### MCP server (`src/app/api/mcp/`, `src/lib/mcp/`, issues #147/#149)

Stateless Streamable HTTP over `@modelcontextprotocol/sdk`, authenticated by personal `sbk_…` tokens kept as a sha256 in `mcp_connections`. Full design in [`docs/architecture/mcp.md`](docs/architecture/mcp.md). The rules that are easy to break:

- **Naming: code says `mcp`, the interface says 連結的應用程式, and "agent" means only the AI on the other end.** A connection can be n8n or a script, so tables, routes, types and the audit `source` are `mcp_*` / `Mcp*` / `"mcp"` (#155 shipped them as `agent_*`; `migrations/0005-rename-agent-to-mcp.ts` renamed them). Not `app_*` either: `"app"` already means the Mini App / Web App, and `src/app/app/` is the Web App. Users see 連結的應用程式, MCP 伺服器網址 and 個人存取權杖, never AI 助理.
- **`getAuth` must keep refusing `sbk_` tokens** and `getMcpAuth` must keep refusing everything else; REST and MCP are separate doors.
- **Every tool goes through `openGroup`** (rate limit → `assertGroupMember` → `assertGrant`), checked on every call. A new tool never reads a group before it.
- Writes go through `src/lib/records/` with `actor: { source: "mcp", mcpConnectionId }`; never insert expense rows from a tool.
- **Results carry the data as `structuredContent` and as one JSON text block in `content`** (some clients show a model only `content`). The first text block is a fixed sentence of ids and numbers; user-controlled text (descriptions, names) appears only as string values inside the JSON, never in prose.
- People are matched exactly within the group and never guessed (`mcp/names.ts`).
- A new column referencing `users.id` on connection tables is moved in `mergeAccounts` (`mcp_connections` is).

### Help site (`src/app/help/`)

Public Traditional-Chinese documentation, rendered from `.mdx` page files via
`@next/mdx` (`pageExtensions` + `withMDX` in `next.config.mjs`; `remark-gfm` for
tables, `rehype-slug` for heading anchors). Every MDX element is mapped to a
design-system-styled React component in the **root-level** `mdx-components.tsx`
— which is why `tailwind.config.ts`'s `content` array must list
`./mdx-components.tsx` explicitly, or Tailwind purges every class the docs rely
on and the pages ship unstyled in production.

The remark/rehype plugins are passed to `createMDX` **by package name**
(`"remark-gfm"`, `"rehype-slug"`), not as imported functions: `pnpm dev`
(Turbopack) serialises the loader options and fails on a function. Keep
`@next/mdx` on the same major as `next` (both 15.x) — a mismatch fails Turbopack's
config validation.

The privacy policy and terms of service are help pages too (`/help/privacy`,
`/help/terms`, the URLs given to Google's OAuth consent screen). They describe what
the code actually collects and who sees it, so a change to stored personal data, a
new third-party service or a new login provider updates `privacy/page.mdx` in the
same commit. The contact address comes from `CONTACT_EMAIL` through
`<ContactEmail />` (`src/components/help/ContactEmail.tsx`), never a literal.

`src/app/help/layout.tsx` holds the section list. **Adding a page means adding
both `src/app/help/<slug>/page.mdx` and an entry in that `sections` array** —
the array drives the sidebar, so a page without one is unreachable.

Entry points into the site are deliberately spread across every surface, since
documentation nobody can find is worthless: the bot's `/help` reply and both
`/start` welcomes carry a URL button, and 個人設定 → 關於 has 使用說明,
隱私權政策 and 服務條款 rows in the Mini App and Web App (`Platform.HelpAction`
takes the path); `/login` links the latter two under its buttons. All of them resolve the URL through
`src/lib/help-url.ts`, which derives it from `NEXT_PUBLIC_MINI_APP_URL`'s origin
rather than adding a second env var the two could disagree about. The Mini App
row calls `WebApp.openLink` instead of using an `<a>`, because navigating the
Mini App's own webview to `/help` would replace the app and strip its back button.

**The docs describe user-visible behaviour, so they go stale silently.** When a
change alters bot copy, a button label, a form field, or who is allowed to do
something, update `src/app/help/**` in the same commit.

### API Auth (`src/lib/auth/`)

Every API route handler wraps with `withAuth` (`src/lib/auth/route.ts`), which turns any thrown `HttpError` (`AuthError`, `BadRequestError`) into its status; the handler calls `getAuth(req)`. `getAuth` accepts **two** auth sources and returns the same `Auth { user, groupFromParam? }` shape regardless:

1. **Mini App** — `Authorization: tma <raw>` header → HMAC-verify the Telegram `initData` string (`src/lib/auth/initData.ts`) → upsert user + resolve `start_param` → group (`groupFromParam` set).
2. **Web App** — `session` cookie → look up a non-expired row in `sessions` → user (`groupFromParam` is `null`; the web frontend picks the group itself).

Group membership is enforced separately via `assertGroupMember`.

### Web Auth (`src/auth.ts`, `src/lib/auth/`)

Standalone web login runs on **Auth.js (NextAuth v5)** with a Drizzle adapter (`src/lib/auth/nextAuthAdapter.ts`). Providers: **Telegram** (custom OAuth2 + PKCE — see [`docs/telegram-oauth-spec.md`](docs/telegram-oauth-spec.md) for the protocol quirks), plus optional **GitHub** / **Google** / **LINE** (enabled only when their env vars are set; the flags live in `src/lib/auth/providers.ts`, which route handlers can import without pulling in NextAuth). Handler routes live at `/api/auth/[...nextauth]` and `/api/auth/logout`.

Identity is **multi-provider**: one `users` row can have many `auth_identities` (`provider`, `providerUid`). Both the Mini App (`initData`) and Telegram web login key on the **numeric Telegram user id** (not the OIDC `sub`), so the same person resolves to one user across both paths. The bot's user-upsert path goes through `src/lib/auth/upsertTelegramUser.ts`.

Linking, display names, avatars and account merging are described in full in [`docs/architecture/auth.md`](docs/architecture/auth.md). The rules that are easy to break:

- **Email auto-linking is on for GitHub and Google only, deliberately off for LINE**: LINE doesn't promise the email is verified, so matching on it would allow account takeover. Telegram has no email, so a Telegram user who signs in with Google/LINE without linking first gets a new, empty user.
- **Two users are only ever merged by the explicit, confirmed merge flow** (`src/lib/account-merge.ts` + `account-merge-db.ts`). Signing in with an identity that belongs to another user, while signed in, turns into a merge offer (`mergeRedirect`); the ticket id travels only in the httpOnly `merge_ticket` cookie, never a URL. Linking and merging are web-only (`Platform.linkIdentity` / `openInBrowser`), since OAuth can't run in Telegram's webview.
- **A new column referencing `users.id` must be moved in `mergeAccounts`**; a non-cascading one goes in `repointUserReferences` (`member-merge-db.ts`), which claiming a placeholder shares.
- **Telegram is linkable from the web too**: the adapter's `linkAccount` sets `users.telegram_id` (what the bot and Mini App key on) in the same transaction as the identity insert, and becomes a merge offer when another account already owns that id.
- Unlink only through `DELETE /api/me/identities/[provider]` (409s on the last method, `canUnlink`). **Never call the adapter's `unlinkAccount`**, which has no guard. Telegram can't be unlinked.
- **Names**: `first_name` / `last_name` are the provider's and `upsertTelegramUser` overwrites them on every update; `display_name` is the person's own choice and only `PATCH /api/me/profile` writes it. **Every rendered name goes through `displayName()`** (usually via `labelUser` / `labelMember`); `display-name-coverage.test.ts` fails any file that selects `users.firstName` without `users.displayName`. Names aren't unique; `memberLabels` disambiguates them.
- **Avatars** are resolved per request by `pickAvatar` / `resolveAvatars` (`src/lib/avatars.ts`) from `users.avatar_source` (null = automatic) and each login's `auth_identities.picture_url`. `upsertTelegramUser` writes `avatar_url` only when Telegram sent a photo.
- Google answers `403 disallowed_useragent` inside LINE's / Telegram's in-app browser, so `/login` disables the button there (`isInAppBrowser`).

Requests: the Mini App's store uses `tmaRawFetch` (`src/lib/tma-fetch.ts`, attaches the `tma` header); the Web App's uses `webRawFetch` (`src/lib/web-fetch.ts`, `credentials: "include"`, cookie-based).

### Database (`src/db/`)

Drizzle ORM + Neon Serverless Postgres. Tables defined in `src/db/schema.ts`:
`users` (`display_name` / `avatar_source`: see [`docs/architecture/auth.md`](docs/architecture/auth.md)) → `groups` (identified by `(chat_type, chat_id)`, see below) → `group_members` (join) → `expenses` → `expense_payers` + `expense_splits` + `expense_receipts` → `exchange_rates` + `group_exchange_rates` + `auth_identities` + `sessions` + `account_merge_tickets` + `receipt_awaiting` + `add_awaiting` + `group_delete_requests` + `group_invites` + `record_audit_log` + `user_beancount_configs` (per-user, per-group beancount export: three accounts and the `last_exported_at` watermark; `UNIQUE(user_id, group_id)`; `corrections_since` = when the last file was built) + `push_subscriptions` (one row per device receiving push; see "Home screen and push") + `rate_limit_hits` (attempt counters, `(key, window_start)`; see the invite rules below; also the MCP per-connection limits) + `mcp_connections` (MCP tokens, see "MCP server") + `mcp_idempotency`. `group_members.push_muted` is the per-group push switch.

**A group's chat is `(chat_type, chat_id)`**, not a Telegram-only column: `chat_type` is `'telegram'` today (room for other platforms), `chat_id` is text, both NULL together (`groups_chat_pair` CHECK) and `UNIQUE(chat_type, chat_id)`. **Never read or query these two columns directly — go through `src/lib/chat.ts`** (`telegramChatId(group)`, `requireTelegramChatId(group)`, `whereTelegramChat(id)`, `telegramChatColumns(id)`). A query that forgets `chat_type` doesn't error; it silently matches the wrong group once another platform issues the same id. `chatMigration` rewrites both columns when a chat is upgraded to a supergroup.

Web groups, `/link`, invites, placeholder members, claiming and one-person groups are described in full in [`docs/architecture/groups-and-members.md`](docs/architecture/groups-and-members.md). The rules that are easy to break:

- **Groups created on the web have no chat** (both columns NULL). Anything that talks to Telegram uses `telegramChatId(group)` and skips quietly on null; `requireTelegramChatId` is only for bot code running inside a chat. A web group binds a chat later with `/link <邀請碼>` (decision: the pure `planLink`, `src/lib/link-plan.ts`). **Unlinking is `unlinkChat` (`src/lib/group-chat.ts`), shared by `DELETE /api/groups/[id]/chat` and the bot's `/unlink`**: it nulls the pair via `noChatColumns()` _and_ every record's `notice_message_id` in one transaction (those ids belong to the old chat), logs `chat_unlinked`, then `leaveUnlinkedChat` says goodbye and **leaves the chat** (best effort, never undoes the unlink). Any member may, whatever the group's origin (`planUnlink`); `/unlink` only posts a confirmation prompt and its button does the work.
- **Invite codes are 10 Crockford base32 characters (~50 bits); don't shorten them.** Every unusable code (and `/link` from a sender who isn't a member) gets the same 404 / `INVITE_NOT_FOUND`, so no response says which codes exist.
- **Every lookup of an invite code is rate limited, before the lookup** (issue #121): `GET /api/invites/[code]` and `…/accept` call `enforceInviteRateLimit` right after `getAuth` (one shared bucket per user, a looser one per IP), and `/link` counts per sender and per chat. Limits live only in `src/lib/rate-limits.ts` (pure, with `decide`); counting is one upsert into `rate_limit_hits` (`src/lib/rate-limit.ts`), fixed windows, failing open, old rows swept on use. A refusal is `429` + `RATE_LIMITED` — never `INVITE_NOT_FOUND` — and **never tells a person how long to wait**: `Retry-After` is always the full window (600), not the time left, and the bot replies only to the first refusal in a window. IPs are stored only as an HMAC. A new route that resolves a code calls `enforceInviteRateLimit` too; `invite-rate-limit-coverage.test.ts` fails one that doesn't. A group has at most one live code (`rotateInvite` + partial unique index). `invite.ts` builds and parses the `/join/<code>` link. Invites work for Telegram groups too.
- **Placeholder members** (no account) are `users` rows with `placeholder_group_id` set, cascading with the group; the Auth.js adapter filters them out. Names are unique per group, under an advisory lock (`src/lib/member-name-lock.ts`).
- **Delete a group only through `deleteGroup` (`src/lib/group-delete.ts`)**, never a bare `DELETE FROM groups`: placeholders' non-cascading payer/debtor foreign keys would fail it.
- **Claiming a placeholder** (`mergeUserInto`, `src/lib/member-merge-db.ts`; decisions in the pure `member-merge.ts`) must combine split rows itself: they have no unique key, so a skipped combine leaves two rows for one person without an error. Any member may merge, with no consent and no undo, by decision (`MergeMemberDialog` shows what moves before confirming). It writes in bulk, logs `member_claimed` after commit, and refreshes only the newest chat cards (`refreshClaimedNotices`).
- **Adding people has one entry, `AddMemberDialog`** (placeholder or invite code), used by 群組設定 and the one-person group card.

**Multi-payer model**: An expense has one or more payers in `expense_payers` (who paid, how much each) and one or more debtors in `expense_splits` (who owes, how much each). Both tables reference `expenses.id` with `ON DELETE CASCADE`. `expense_payers` has a `UNIQUE(expense_id, payer_id)` constraint. Both sides must sum to `expenses.amount`.

**Settlements are expenses**: A repayment ("A 還 B $X") is just a degenerate expense — A is the sole payer, B the sole debtor — with identical balance impact. It is stored in `expenses` with `type='settlement'` (vs `type='expense'`), one `expense_payers` row (= sender) and one `expense_splits` row (= receiver, `share_type='exact'`). There is **no** separate `settlements` table. The `type` column is the only discriminator: balance/FX/rate-lock treat both kinds the same (no branching), while the expense list/detail and stats filter `type='expense'` and the merged group list renders `type='settlement'` rows as `from → to`. The `/api/groups/[id]/settlements` routes are a from/to-shaped façade over `type='settlement'` expenses for the forms: `POST` creates and `[settlementId]` reads, edits and deletes one. There is no list `GET` — settlements appear inline in the main list at `GET …/expenses`.

**A record's date is a day, not an instant (issue #144).** `expenses.spent_date` is a Postgres `date`; in code, in the API (`spentAt` / `settledAt`) and in `RecordSnapshot` it is a `YYYY-MM-DD` string, and Drizzle's `expenses.spentAt` maps to that column in string mode. It has no time and no zone, so nothing converts it: the forms send the day the person picked (`localDateToDay`), a rate lookup uses it as its key, and every comparison is a string comparison. Pure helpers live in `src/lib/day.ts` (`isDay`, `todayIn`, `dayInZone`, `addDays`, `snapshotDay`); **never derive a day with `toISOString().slice(0, 10)`** or read it back out of a UTC-noon timestamp. The old `spent_at timestamptz` column is deprecated and still present for one release (schema.ts `spentAtLegacy`; the previous release reads and writes it while a deploy is in flight). `migrations/0004-spent-date.ts` adds `spent_date`, backfills it in the group's zone (`(spent_at AT TIME ZONE g.timezone)::date`, so an old bot record keeps the day its rate always came from and `/balance` does not move) and installs the `expenses_sync_spent` trigger that keeps the two columns equal in both directions; **the next release drops `spent_at`, its two old indexes and the trigger.** Audit snapshots logged before the change hold an ISO instant in `spentAt`: read them only through `snapshotDay`, which gives the day in the default zone (the zone every group was in then).

**A group's time zone** (`groups.timezone`, IANA name, `NOT NULL DEFAULT 'Asia/Taipei'`) has exactly two jobs: deciding which calendar day _now_ is (the bot's `/add` with no date records `spentAtForNow(group.timezone)`; a settlement posted without a date, the stats presets, export filenames and "today" for a market-rate lookup use `todayIn(group.timezone)`), and nothing else. It never moves a record that already has a date. Any member may change it (like the default currency); every change goes through `changeGroupTimezone` (`src/lib/group-timezone.ts`), shared by `PATCH /api/groups/[id]/settings` and the bot's `/timezone` buttons, which validates with `isValidTimeZone` (`Intl.supportedValuesOf("timeZone")`; an arbitrary string is refused on both paths) and logs `timezone_changed` (a group event, `{kind:'timezoneChanged', from, to}`; a no-op change logs nothing). **Rate lookups take a `GroupRateContext`** (`{ overrides, timeZone }` from `loadGroupRateContext`), not a bare overrides map, so a caller cannot pass the custom rates and forget the zone. `FX_TIME_ZONE` is only the default for a new group. Surfaces: 群組設定 (`TimeZoneSelect` + confirm dialog), 建立群組 (defaults to the device zone), the `TimezonePrompt` on 群組頁 (asks only when the device's _current UTC offset_ differs from the group's; 不用 is remembered in `localStorage` per group and device zone, `timezonePromptKey`), and `/timezone` (`src/bot/commands/timezone.ts`, buttons for `COMMON_TIME_ZONES`; its callback data is built and parsed in that file). The purpose text (`TIMEZONE_PURPOSE`) is worded once in `src/lib/timezone.ts`.

`expenses.notice_message_id` holds the `message_id` of that record's message in the group chat — the expense card for an expense, the notice for a settlement (see Group notifications below). `NULL` for records predating the feature or when the send failed.

`receipt_awaiting` stores in-flight "waiting for receipt photo" state for the ForceReply bot flow (only triggered after text-only `/add`; not shown when photo is already attached via caption). `add_awaiting` stores in-flight ForceReply prompts: with `expense_id`/`field` NULL it's a bare `/add` waiting for expense text, otherwise the reply sets one field (`amount` / `currency`) of an existing expense and `panel_message_id` says which card to refresh.

Schema is pushed with `db:push` in the Vercel build, after the data migrations below. `numeric` columns come back as strings from Drizzle; use `n()` from `src/lib/money.ts` to parse them to numbers.

**Data migrations run in the Vercel build** (`scripts/vercel-build.sh`: `db:migrate` → `db:push` → `next build`, on production and on **every** preview — each branch has its own Neon database and the E2E run reads it, so a branch that adds a column would otherwise fail every case; only production and the `dev` preview also set the bot's commands and webhook, which are global to the one bot). `scripts/migrate.ts` applies each unrecorded file in `migrations/NNNN-name.ts` (`export default async function up(sql)`) and records it in `schema_migrations` (also declared in `schema.ts`, otherwise `db:push --force` drops it); a throwing migration fails the build, so the release never ships. Two rules, both because the previous release is still serving traffic while the build runs: a migration must be **idempotent** (there is no lock), and it must work against **both old and new code** — add, backfill and relax in one release, drop in a later one. `pendingMigrations` (`src/lib/migration-plan.ts`) is the pure, tested part. The one-off `scripts/migrate-*.ts` below predate the runner and were run by hand.

**Schema upgrade procedure** (when adding tables or dropping columns): if the change requires a data migration, add `migrations/NNNN-name.ts` — it runs in the next build, before `db:push`. Because `db:push --force` runs in that same build with the old release still live, **never remove a column or constraint the old code reads in the same release as the migration**: keep it in `schema.ts` (nullable, marked deprecated) and drop it in the next release. `migrations/0001-group-chat.ts` is the worked example, including a trigger that keeps rows the old code inserts mid-deploy in sync. **A drop and an add in the same table need a migration too**: drizzle-kit then asks whether each is a rename, a prompt it can't show without a TTY, so drop the old columns in `migrations/` first and leave `db:push` only additions (`migrations/0003-drop-beancount-receivable-columns.ts`). `scripts/vercel-build.sh` fails the build when `db:push` prints an `Error` line, because drizzle-kit can exit 0 after one, and a build that carried on would ship against an unsynced schema (on a preview that shows up as every E2E case failing on a missing column). The older `scripts/migrate-payers.ts` is the pre-runner style.

### Settlement logic

Split across two files deliberately:

- `src/lib/settlement-core.ts` — pure greedy min-transfer algorithm, no DB, fully testable
- `src/lib/settlement.ts` — DB queries that build `NetBalance[]`, then delegates to core

`computeGroupBalances` joins through `expense_payers` (not `expenses`) to credit payers, and through `expense_splits` to debit debtors. Both sides are FX-normalised to the group's `defaultCurrency` using historical rates. Settlements need no special handling: stored as `type='settlement'` expenses, their sender/receiver flow through the same payer/split legs.

### FX (`src/lib/fx.ts`)

Rate resolution priority, highest first:

1. **Per-record pinned rate** — `fx_rate` + `fx_quote` on `expenses` (both `type='expense'` and `type='settlement'` rows; set via the form's 匯率 field when the record currency differs from the group default, or written by the rate-lock flow). Applies only while `fx_quote` matches the group's current default currency; goes dormant (falls through) if the default changes later — and PATCH preserves dormant pins so they revive if the default reverts. `fx_quote` is stamped server-side by `resolveRecordFx` / `fxColumnsFor`. All balance/stats conversions go through `resolveRate` in `src/lib/fx.ts`, the single place that encodes this priority order.
2. **Group custom rate** — `group_exchange_rates` rows (managed in group settings via `GET/PUT/DELETE /api/groups/[id]/rates`). One agreed rate per `(group, base, quote)` that applies to **all** of the group's expenses in that currency, past and future — a deliberate departure from the historical-rate principle. Inverse pairs are derived automatically (`buildOverrideMap`); upserting a pair replaces any explicit inverse row so the two directions can't drift apart. Loaded once per request with `loadGroupRateOverrides` and passed to `getRate` as the optional `overrides` map.
3. **Market rate** — cached per `(base, quote, date)` in the `exchange_rates` table (global, shared across groups; group overrides are never written into it). Historical expenses always use the rate as of their `spent_date`, so balances don't silently shift when rates move. The cache holds exactly one row per `(base, quote, day)`: `getRate` looks up that day only, and on a miss fetches that day from the API and stores it under the **requested** day (a weekend is answered with the previous business day's rate, still stored under the weekend day; a day that hasn't happened yet is not cached). Historical rates don't change and rows are cheap, so there is deliberately no "nearest earlier row within N days" fallback: with one, a record's converted amount moved whenever another record populated a closer day, and the first rate ever cached for a pair matched every later date. A record's day is already a `YYYY-MM-DD` string, so `getRate(base, quote, day, ctx)` uses it as the key as it is; the group's zone (`ctx.timeZone`) decides only what day _today_ is (a day that hasn't happened yet isn't cached, and today asks the API for `latest`). Nothing derives a day with `toISOString().slice(0, 10)`; the bot's `/add` records `spentAtForNow(group.timezone)`. The rate field's placeholder reads `<rate>（當日市場匯率）` or `<rate>（群組自訂匯率）` (`rateSourceLabel`), a skeleton sits in the empty field and the ≈ line while `isFetching` (the query keeps the previous date's `data` meanwhile) and the field stays editable; there is deliberately no separate "rate date" input: the rate follows the record's date, and a different rate is a typed per-record one.

`GET /api/groups/[id]/rates/effective?base=X` returns the effective rate (group override or market) and the market reference; with `&counts=1` it also returns `affectedExpenses`/`affectedSettlements` (existing records in `base` without an applicable pin, split by `type='expense'`/`'settlement'`). The forms use it without counts for the rate prefill; the settings page uses it with counts and blocks save/delete until they load.

When existing records would be re-converted, the settings page asks for the scope before saving or deleting. `PUT /api/groups/[id]/rates` with `lockExisting: true` (and `DELETE …?lock=1`) first pins every affected expense **and settlement** at its **current** effective rate (old group rate or per-day market rate, resolved by `planRateLock` in `src/lib/rate-lock.ts` before the write transaction; both kinds are `expenses` rows, told apart by `type`) so the change only applies to future records — this is how "each trip has its own agreed rate" is supported. Changing the group's default currency also pops a warning, since it re-converts everything at market rates and makes all custom rates/pins dormant.

### Stats (`src/lib/stats-core.ts` + `GET /api/groups/[id]/stats`)

Personalised (`userId`, defaults to the caller) and range-scoped (`3m` / `6m` / `1y` / `all` / `custom`), with the same pure/DB split as settlement logic. Full design in [`docs/architecture/stats.md`](docs/architecture/stats.md). The rules that are easy to break:

- A `userId` other than the caller **must pass `assertGroupMember`** (no extra permission beyond that, since there's no per-record privacy).
- `custom` takes `from` / `to` as **`YYYY-MM-DD` days, inclusive** (`customRangeToQuery` just passes the picked days through; a record's date has no time and no zone, so there is nothing to translate). Presets count back from the group's today (`todayIn(group.timezone)`), clamping the day-of-month (`monthsAgo`). The picker uses `dayToLocalDate` / `localDateToDay` (`src/lib/day.ts`), never `new Date(str)`.
- `netTrend` (a day-count window that carries the earlier total in) and `monthly` / `byPayer` (the last N calendar months, `recentMonthKeys`) use **different windows on purpose**; `monthly` and `byPayer` must always share one.
- `byPayer` reads `expense_payers` (who paid); `monthly`'s member line reads `expense_splits` (their share). Don't conflate them.

### Receipt photos (`src/app/api/tg-photo/` and `src/app/api/tg-upload/`)

Receipts are stored on Telegram's servers — only the permanent `file_id` is persisted. An expense can have **up to 5 receipt photos**, stored as rows in `expense_receipts` (`position` sets display order). The legacy single-photo column `expenses.receipt_file_id` still exists and is written by the bot's `/add`; the expenses API merges it with `expense_receipts` rows. Serving goes through the `/api/tg-photo` proxy (accepts `?fileId=` or `?path=`) so the bot token never appears in client URLs. **Every proxy link is signed** (`src/lib/tg-photo-sign.ts`: HMAC keyed off the bot token over the file id or path, built and verified in one file): `<img>` can't send the Mini App's `Authorization` header, so the proxy can't ask for a login, and the signature is what stops a leaked `fileId` or a guessed `photos/file_N.jpg` path from reading receipts. Authenticated routes mint the links (`receiptUrls` on the expense detail response, `url` from `/api/tg-upload`, avatar and group-photo URLs); a new place that shows a Telegram photo must use `receiptPhotoUrl` / `pathPhotoUrl`, never build `/api/tg-photo?…` by hand. The proxy rejects `..` in paths, forces an image content type, sets `nosniff` and caches `private`.

Upload flow (Mini App): `POST /api/tg-upload` (auth-protected) → `sendPhoto` to the private storage channel → returns `file_id` → saved with the expense.

Upload flow (bot): photo sent as a caption `/add …` stores `file_id` directly — the caption path goes through the same `handleAddParsed` as a text `/add`, so mentions and the ⚙️ 調整 panel work identically (only multi-photo albums are refused). The "🧾 收據" inline button on the card triggers a ForceReply prompt; the reply photo is matched via `receipt_awaiting`.

### Group messages for records (`src/lib/notify.ts` + `src/lib/record-notice.ts`)

Every record — **expense and settlement alike** — owns exactly **one** message in the Telegram group chat for its whole life, tracked by `expenses.notice_message_id`:

- **created** → send it, remember the `message_id`
- **edited** → `editMessageText` that same message in place (never a second message)
- **deleted** → the message is **kept** and edited into the `🗑 已刪除 …` line, with its inline keyboard dropped

This is what connects the two front ends to the chat: editing an expense in the Mini App refreshes the **same card** `/add` posted, and deleting it from either side leaves the same tombstone.

**There is exactly one renderer per message, and that matters more than it looks.** An expense renders as the expense card (`renderCard`, `src/bot/expenseCard.ts`) — the same text and buttons `/add` posts. A second, simpler renderer for "the notification" would silently downgrade a card into a plain line (losing ⚙️ 調整, the `≈` conversion line and the `×n` weights) the first time someone edited from the app. So `renderCard` takes a `CardOrigin` (`{ botUsername, chatId }`) rather than a `BotContext`, which is what lets an API route handler render the identical card without an update to hang off. `src/lib/record-notice.ts` holds only what the card doesn't cover: `formatSettlementNotice` (settlements have no card) and `formatDeletedNotice` (shared by both kinds); both are pure and unit-tested.

`/add` binds its own card with `rememberNoticeMessage` right after `ctx.reply`, so a bot-created expense never gets a duplicate — and since `receiptUpload.ts`'s photo-caption path delegates to `handleAddParsed`, that one call site covers every bot-created expense. Everything created from the Mini App / Web App is sent by the API route handler.

`src/lib/notify.ts` does the delivery: `loadNoticeRecord` / `sendRecordNotice` / `updateRecordNotice` / `markNoticeDeleted`, all of which swallow their errors — a kicked bot or a manually deleted message must never fail the API request. An edit falls back to posting a fresh message (and re-remembering it) when there is nothing editable; Telegram's `message is not modified` rejection is treated as success, not a reason to re-post. An edited card re-renders in `default` mode, so a card left open on the ⚙️ panel collapses back to the summary — the panel mode is UI state, not part of the record.

Three things to keep in mind when touching this:

- **Deletes must snapshot first.** Call `loadNoticeRecord` _before_ deleting the row — the record, its creator and its `notice_message_id` are gone afterwards. Both the bot's `del_exp` callback and the API's `DELETE` do this.
- **The tombstone's attribution is load-bearing.** `formatDeletedNotice` names what went, who recorded it and who removed it. That is what stands in for the per-record owner lock this app deliberately doesn't have (see "Who may edit or delete a record") — don't quietly reduce it to "已刪除".
- **Silence is inherited.** Messages are silent because the bot's api middleware (`src/bot/index.ts`) stamps `disable_notification: true` on every `send*` call. Nothing in `notify.ts` sets it explicitly, so removing that middleware would un-silence every one of them.

Deep links: the card's 🔗 App 編輯 uses `?startapp=group_<chatId>_exp_<id>`, a settlement notice `_stl_<id>` — both parsed in `src/lib/auth/index.ts`, surfaced as `activeExpenseId` / `activeSettlementId` by `/api/me/groups`, and redirected in `GroupsHome` (`src/components/pages/GroupsHome.tsx`, shared by `/mini` and `/app`). A `startapp=join_<code>` link (`joinLink` in `deep-link.ts`) is the third payload: `parseStartParam` returns a `kind: "join"` result, `getAuth` carries only the normalised code as `inviteFromParam` (surfaced as `activeInviteCode`) and **never joins at auth time**, and `GroupsHome` sends the viewer to `<basePath>/join/<code>` so they see the preview and confirm. The 🗑 刪除 button on both is the same `del_exp:<id>` callback, group-scoped and (per the policy above) not owner-gated.

### Expense list pagination (`src/lib/expense-cursor.ts` + `getExpenses` in `src/store/api.ts`)

`GET /api/groups/[id]/expenses?cursor=` returns `{ expenses, nextCursor, total }`, `EXPENSES_PAGE_SIZE = 30` per page, ordered `(spent_date DESC, id DESC)`. The date is user-editable and not unique, so the cursor is the pair `YYYY-MM-DD_<id>`, built and parsed in `expense-cursor.ts`; within one day the order is `id DESC` (entry order), since a date has no time to break the tie. A malformed cursor — wrong shape (including the old microsecond-text form), an impossible date such as Feb 31, or an id beyond int4 — is a 400, not a Postgres error. `expenses_group_list_date_idx` (`group_id, spent_date DESC, id DESC`) matches that order and the row-value cursor comparison, so a deep page seeks instead of sorting the group. `total` (every record, settlements included) is counted on the first page only and feeds the list header; with "只看我的" on, the header shows the filtered count of what is loaded with a `+` while more pages remain, because that filter is client-side.

Both the list page and the activity feed load further pages through `useAutoLoadMore` (`IntersectionObserver` on a sentinel, capped at 5 consecutive loads so a "只看我的" filter matching nothing can't drain a big group; the cap resets when the sentinel leaves view) and render `LoadMoreFooter`. Its 載入更多 button appears only as the fallback: no observer, a failed page, or the cap. A tap on the button re-arms auto-loading. A failed page or a failed refresh keeps the loaded list on screen and shows the button as a retry (it refetches when there is no next page).

### Record writes (`src/lib/records/`, issue #148)

Creating, editing and deleting an expense or settlement lives in one place: `createExpense` / `updateExpense` / `createSettlement` / `updateSettlement` / `deleteRecord`. Each takes already-validated input (`expenseInputSchema` / `settlementInputSchema`) and a `RecordContext` (`{ actor, api? }`), and does the membership check on the people involved, the FX pin (`resolveRecordFx`, `resolveUpdateFx` with its dormant-pin rule), the transaction and the `logCreated` / `logUpdated` / `logDeleted` call. The REST route handlers only do auth, `requireId`, `safeParse` and one call; the MCP server (issue #147) is a second caller. Two copies of this logic would drift without an error (payer/split sums, `SUPPORTED_CURRENCIES`, pinned rates, the date and the group's zone), which is the sharing rule's test. The functions throw `HttpError`s (`BadRequestError`, `NotFoundError`) that `withAuth` already answers, and keep the order the routes always had: body 400, record 404, from≠to 400, users-not-in-group 400. `api` defaults to the bot's; `null` means the caller renders the group message itself. The bot's panel edits stay in `src/bot/expenseEdits.ts`, since they render the card in modes this layer must not flatten.

### Audit log (`src/lib/record-mutation.ts` + `record-audit.ts` + `record-history.ts`)

Every create, edit and delete of a record is logged to `record_audit_log` with
who did it, from which surface (`bot` / `app` / `mcp`; an `mcp` write also carries `mcp_connection_id`, a plain nullable column until the connections table exists), and a full before/after snapshot. This is the
accounting half of "any member may edit anything" — without it, relaxing the
owner lock would mean changes are both unrestricted _and_ untraceable.

**Audit, the group message and push are one layer, on purpose. Do not split them.**
`logCreated` / `logUpdated` / `logDeleted` write the log _and_ drive
`src/lib/notify.ts`. The mutation sites are spread across many route
handlers and bot callbacks; a standalone `logAudit()` next to each would
eventually be forgotten somewhere, and a missing audit row is invisible.
Fusing it to the one thing those sites already cannot skip — keeping the
Telegram message in sync — means forgetting shows up the same day, as a message
that stops matching the record. `actor` is a required argument for the same
reason: the compiler asks "who did this?" at every call site. Push notifications
(`queueRecordPush`, see "Home screen and push") ride on the same three calls, so a
mutation site can't forget them either.

Passing `api: null` says the caller owns the group message and will render it
itself (the bot's panel buttons, which re-render the card in a mode this layer
must not flatten; and `/add`, which posts the card it just built). **The log is
written either way** — there is no call shape that logs nothing.

Other things to know:

- **`record_id` has no foreign key, deliberately.** `ON DELETE CASCADE` would
  erase "who deleted this" at the exact moment that row becomes the only
  evidence. `group_id` _does_ cascade — deleting the group should take its log.
- **`src/bot/expenseEdits.ts` exists because of an import cycle.** `notify.ts`
  imports `expenseCard.ts` to render a card from a route handler, so that module
  has to stay a dependency-free leaf. Every bot write to an existing expense
  therefore lives in `expenseEdits.ts`, which may import `record-mutation.ts`.
- **Group-level membership events** use `recordType: 'group'` with no record id: `timezone_changed` (`{kind:'timezoneChanged', from, to}`), `member_joined` (payload `{kind:'memberJoined', inviterId, inviterName}`, name captured as it was then), `invite_reset` and `member_claimed` (`memberClaimed`: the placeholder's name, claimer, and the rewritten `recordIds`, so `loadRecordHistory` can show it on each of those records via a `@>` check, like rate locks; the feed reads "X 認領了 Y", or "把 Y 合併到 Z" when the merger isn't the claimer). `GroupEventPayload` has its own guard (`isGroupEventPayload`); `record-history.ts` must branch on it before `summariseRecord`, which would otherwise read the payload as an expense snapshot.
- **A rate lock is logged once for the group, not once per rewritten record**
  (`recordType: 'group'`, `record_id: NULL`) — fanning fifty rows out would bury
  the day's real edits. The affected ids ride in the JSONB payload so a single
  record's history can still explain why its converted amount moved;
  `loadRecordHistory` matches them with a `@>` containment check.
- **An empty diff writes no row.** The expense PATCH replaces payers and splits
  wholesale on every save, so `diffRecords` (pure, unit-tested) decides whether
  anything a reader cares about actually moved.
- Snapshots reuse `NoticeRecord` plus a few columns, so the log can't drift into
  describing records differently from the chat message. Names are captured as
  they were then — that is the point of a log.
- Retention is unbounded. At this app's scale that's fine; if it ever isn't, null
  out `before`/`after` on old rows rather than deleting them, since the row
  itself is the evidence.

Surfaces: both record forms show 由 X 於 T 記錄 and, once edited, a tappable
最後由 Y 於 T 修改; `/{mini,app}/groups/[id]/activity` is the group feed, and the
same page with `?record=<id>` is one record's history. Rows there (including a deleted record's) link to that history through `recordHistoryHref` (`src/lib/activity-link.ts`), which also carries a `from` page, so 返回 goes back to the edit form or the feed that opened it; the same file parses `from` and accepts only a page inside the same group and front end (anything else falls back to the group home). A row shows its time top-right and `›` bottom-right in a column of fixed width, so rows without a link keep their time aligned.

### Home screen and push (`public/sw.js`, `src/lib/pwa.ts`, `src/lib/push*.ts`, issue #67)

Web App only; the Mini App fills these `Platform` slots with nothing. Full design in [`docs/architecture/push.md`](docs/architecture/push.md). The rules that are easy to break:

- The interface says **加到主畫面, never 安裝 App**.
- `public/sw.js` is hand-written and push-only: no fetch handler, no offline cache, no build plugin (keeps `next dev --turbopack` working). `AuthProvider mode="web"` registers it.
- The manifest's `scope` is `/`, not `/app`, so `/login`, the OAuth callbacks and `/join/<code>` stay inside the home-screen app. `LAUNCH_SCRIPT` (`src/lib/pwa.ts`) is a **string, not a function**, because the bundler rewrites function bodies; `pwa.test.ts` runs that string.
- Recipients come from the pure `pushRecipients` (`src/lib/push-plan.ts`) and **never include the actor**. Pushes ride on `logCreated` / `logUpdated` / `logDeleted` and are delivered in `after()`, swallowing errors; a 404/410 from the push service deletes that subscription.
- **Signing out deletes and unsubscribes this browser's subscription first** (`useForgetPushDevice`), so a signed-out device stops receiving the account's records.
- `requestPermission()` is the first call in the tap handler, before any `await` (iOS refuses it otherwise). Subscription endpoints must pass `isPushServiceUrl`, because the server POSTs to them.
- Optional: without all three VAPID variables nothing is sent and the UI hides itself. Headless Chromium has no push service, so delivery isn't E2E-tested.

### CSV 匯出 (`src/lib/csv.ts` + `src/lib/export.ts`)

Three entry points share `buildGroupExport`: the bot's `/export`, `GET /api/groups/[id]/export?format=csv` (Web App download) and `POST /api/groups/[id]/export/send` (the bot posts the file to the group chat). Details in [`docs/architecture/exports.md`](docs/architecture/exports.md).

- The Mini App can't download directly (Telegram fetches the URL itself, without the `tma` header), so it posts to the chat instead.
- 換算金額 stays at 4 dp (`FX_DP`) through `resolveRate`, so the column sums to `/balance`.
- Text starting with `= + - @` gets a `'` prefix (formula injection).

### Beancount 匯出 (`src/lib/beancount.ts` + `beancount-export.ts`, issue #117)

A member's personal export, from their own ledger's point of view; it never goes to the group chat. Three accounts: Expenses, Cash, and **one** event account per group whose balance equals the member's `/balance`. Details in [`docs/architecture/exports.md`](docs/architecture/exports.md).

- One event account instead of one receivable per person, on purpose: min-transfer settle-ups would leave per-person receivables that never return to zero.
- `recordPostings` / `recordToBeancount` / `groupToBeancount` are pure. Loading is shared with the CSV (`loadGroupRecords`), so the two exports agree on rates.
- Range `new` also writes **corrections** for records edited or deleted since the last export (issue #124; `beancount-corrections.ts`, rules in `docs/architecture/exports.md`): the exported version is the `before` of the first audit row after `user_beancount_configs.corrections_since` (the file's build time, **not** `last_exported_at`, which is a record's `created_at`). A NULL `corrections_since` writes none once. Don't derive "already exported" from `last_exported_at`.
- Range `new` compares `created_at` (not the spending date) with the `last_exported_at` watermark at millisecond precision; only `new` and `all` advance it, through `greatest()`.
- The first export pins an unsaved `event_account` to the default it used, because the default follows the group title and a rename would otherwise move later 上次匯出後 files to an account the ledger never opened.

### Environment variables

Validated at runtime (not build time) via `serverEnv()` in `src/lib/env.ts`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_MINI_APP_NAME` — short name from BotFather `/newapp`
- `TELEGRAM_STORAGE_CHAT_ID` — `chat_id` of the private Telegram channel used as photo storage (bot must be admin with "Post Messages" permission)
- `DATABASE_URL` — Neon pooled connection string
- `NEXT_PUBLIC_MINI_APP_URL` — public URL of the `/mini` route

The web-auth (Auth.js) vars are **not** in `serverEnv()` — Auth.js reads them directly from `process.env`:

- `AUTH_SECRET` — required; signs Auth.js sessions (`openssl rand -base64 32`)
- `AUTH_TELEGRAM_CLIENT_ID` / `AUTH_TELEGRAM_CLIENT_SECRET` — from BotFather → Bot Settings → Web Login
- `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`, `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, `AUTH_LINE_ID` / `AUTH_LINE_SECRET` — optional; each provider is enabled only when its pair is present

Push notifications (issue #67) are optional too, read from `process.env` by `pushConfigured()` (`src/lib/push.ts`), enabled only when all three are set:

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — baked at build time; a new key pair invalidates every existing subscription
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` — `mailto:` address or https URL

Optional, read from `process.env` by `contactEmail()` (`src/lib/contact.ts`):

- `CONTACT_EMAIL` — shown on `/help/privacy` and `/help/terms`; unset, they read 尚未設定聯絡信箱. The pages are prerendered, so a change takes effect at the next deploy

All route handlers must set `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"` because they use the Neon serverless driver.

### Git conventions

Commit subjects and PR titles follow **Conventional Commits**: `type(scope): imperative description`, lowercase after the colon, no trailing period, subject ≤72 chars.

- Types in use: `feat`, `fix`, `chore`, `ci`, `docs`, `refactor`.
- Scope is optional and names an area rather than a file — `bot`, `mini`, `deps`.
- The body carries the _why_. Explanations that a user can't act on belong here, not in the bot's replies (see `src/bot/commands/help.ts`).
- Every PR names its issue in the PR description, on its own line: `Closes #N` when it completes the issue (GitHub closes it when the PR merges into `dev`), `Part of #N` when it is one step of a larger issue, or `No-issue` when none applies. A plain mention such as `See #N` links the issue but leaves it open. When the last checkbox of an issue is ticked outside such a merge, close the issue in the same step.

The prefix is for humans only: the release workflow's semver bump is a manual `workflow_dispatch` input (`.github/workflows/merge-dev-to-main.yml`), **not** parsed from commit types, so a wrong prefix can't mis-release anything. `dev` and `main` are protected by rulesets that require a pull request, so changes land through PRs; only that release workflow pushes directly, with the `RELEASE_DEPLOY_KEY` deploy key on the rulesets' bypass list (`GITHUB_TOKEN` can't be a bypass actor; setup in `docs/DEPLOYMENT.md` → Releasing).

### Deployment

Production runs on **Vercel** (frontend + bot webhook + API in one deploy), served from a **custom domain** (not the default `*.vercel.app`), backed by **Neon Postgres**, with the Mini App registered in **BotFather**. The repo is `chiachunho/splitbill-telegram-bot` (private); `origin` is HTTPS. The **default branch is `dev`** — open all PRs against `dev`, not `main`. Pushing to the default branch triggers Vercel auto-deploy. Full step-by-step in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Node runtime is **24.x**, pinned in two places that must agree: `engines.node` in `package.json` (Vercel reads this and it overrides the dashboard's Node.js Version setting) and `.nvmrc` (CI's `setup-node` reads it via `node-version-file`). Vercel only honours the major version and patches it on its own, so a security release on that line (e.g. CVE-2026-111497 "Node2Shell", fixed in 24.22.1) is picked up on the next deploy, not by editing the pin. CI mirrors that with `check-latest: true` — without it `setup-node` silently uses whatever 24.x the runner image has cached, which lagged behind the Node2Shell fix.

Baseline security headers (`nosniff`, `Referrer-Policy`, and `X-Frame-Options: DENY` on `/app`, `/login`, `/join`) are set in `next.config.mjs`; `/mini` is deliberately frameable because Telegram embeds it, so don't add a site-wide `frame-ancestors`.

Things that bite, in priority order:

- `TELEGRAM_WEBHOOK_SECRET` must be **identical** in Vercel and in local `.env.local` — `/api/telegram` rejects mismatched `X-Telegram-Bot-Api-Secret-Token` headers.
- `NEXT_PUBLIC_MINI_APP_URL` is baked at **build time**; changing it requires a redeploy.
- The build re-runs `pnpm bot:set-webhook` and `pnpm bot:set-commands` on every production deploy and on the `dev` preview (`scripts/vercel-build.sh`), so they are not run by hand. The webhook call passes `drop_pending_updates: true`, so every run also discards updates Telegram is still holding. `allowed_updates` lives on Telegram's side: an edit to the array in `scripts/set-webhook.ts` takes effect only at the next production deploy, and an update type missing from it stops arriving silently after that.
- `chat_member` additionally requires the bot to be a **group administrator**. Without that it's simply never delivered — membership tracking quietly falls back to the narrower `new_chat_members` and invite-link joins go unrecorded.
- Both `NEXT_PUBLIC_MINI_APP_URL` (private-chat button) and the BotFather-registered Web App URL (group direct-link) must point at the production `/mini`.
- Schema and data migrations run in the Vercel build (`pnpm db:migrate` → `pnpm db:push`, see the Database section), on production and on every preview, so no manual step is needed for a deploy.
- **When a schema change requires a data migration**, add a file under `migrations/` (see the Database section). The build runs it before `db:push`, and a throwing migration fails the build, so the release does not ship. New data migrations go in `migrations/`, not `scripts/`.
- `TELEGRAM_STORAGE_CHAT_ID` must be set before deploying the receipt-photo feature. Create a private channel, add the bot as admin, get the `chat_id` (a large negative number), and add it to Vercel env vars + local `.env.local`.

### Testing

Vitest with `vite-tsconfig-paths`. Tests live in `src/lib/__tests__/`, `src/lib/auth/__tests__/`, `src/components/**/__tests__/`, `src/bot/__tests__/`, `src/app/api/__tests__/` and `scripts/__tests__/` (the `.mjs` tools under `scripts/`). Pure lib functions are the bulk of the unit tests. The vitest config injects dummy env vars so modules that import `@/db` don't throw during test collection.

**API routes** are tested for invariants across the whole tree rather than one route at a time (`src/app/api/__tests__/route-guards.test.ts`), so a new route is covered without a new test: every route module declares the Node runtime and `force-dynamic`, and every handler under `/api/groups/[id]/**` answers 401 to a signed-out caller and 403 to a non-member **without touching the database** (`@/db` is a proxy that throws on any access, so a handler that queries before `assertGroupMember` fails, even when it swallows the error), and a case is generated only for the methods a module actually exports. A new dynamic segment needs a value in that file's `SEGMENT_VALUES`. What a route does after the guard is database work, which belongs in E2E (below).

**Bot commands** run through `src/bot/__tests__/harness.ts`: `testBot(composer)` feeds hand-built updates to one Composer, records every Bot API call through an `api.config` transformer (answers default to a plausible result, `answer(method, fn)` overrides one, `ApiFailure` makes it a Bot API error), and sets `ctx.dbUser` / `ctx.dbGroup` in place of `registerUser`. `testDb` stands in for `@/db` (`vi.mock("@/db", async () => ({ db: (await import("./harness")).testDb.db }))`) and records inserts; any query it doesn't model throws. Only `send*` calls have a default answer; any other method a test doesn't stub fails, and `expectAllCallsStubbed()` in `afterEach` reports it, so a forgotten stub can't quietly steer a command down another branch. Cover the decisions that fail silently, such as who `/join` seats when membership can't be verified; a command whose real work is queries is better covered in E2E.

**Component tests** (`*.test.tsx`) render shared components under jsdom: `vitest.config.ts` defines two `projects`: `src/components/**` runs in jsdom and everything else in node, so lib tests don't pay jsdom's startup cost (vitest 5 removed `environmentMatchGlobs`). A hook or helper in `src/lib` that needs a DOM is tested through a component that uses it. `esbuild.jsx` is set to `automatic` because the tsconfig's `"jsx": "preserve"` otherwise makes every `.tsx` test fail with "React is not defined". Each such file imports `@testing-library/jest-dom/vitest` and calls `cleanup` itself, since vitest globals are off. Assert only what a user sees — text, link targets, whether an element or link exists, disabled state — never Tailwind classes or DOM structure, which break on every restyle. Cover the guards that fail silently (a link that must not exist, a grouping that quietly stops). `ExpenseForm` is covered by asserting on the JSON it sends (`ExpenseForm.test.tsx`), since what it can get wrong silently is the body: a split type, weights or payer amounts quietly rewritten by a save that changed something else. Radix measures some controls, so a test that renders one stubs `ResizeObserver`. `SettlementForm` is not covered yet.

**E2E (Playwright)** lives in `e2e/` and runs against an already-deployed site, never a local server. `pnpm e2e` reads `E2E_BASE_URL` (defaults to `http://localhost:3000`) and `E2E_DATABASE_URL`, the DB that site uses. `/mini` is covered by `e2e/mini.spec.ts`: the suite signs initData itself with `signInitData` (`src/lib/auth/initData.ts`, next to the verifier) and opens pages with it in the `#tgWebAppData=` fragment, where `telegram-web-app.js` reads it the way a Telegram client supplies it (`openMini`, `e2e/mini.ts`). That needs `E2E_TELEGRAM_BOT_TOKEN`, equal to the target site's `TELEGRAM_BOT_TOKEN` (a repo secret in CI); without it those cases skip. Fixture users get Telegram ids from 2^52 up, which no real account can have, so initData signed for them (and kept in a failing run's trace) is never a login as a real person; keep it that way. The page bodies are shared, so `/mini` cases cover the `tma` auth path, the `startapp` deep links and a smoke pass of the shared pages; deeper flows stay in the `/app` specs. Web login can't be automated, so `e2e/fixtures.ts` seeds the signed-in user with a `sessions` row and sets the `session` cookie. It also seeds a second group member (no session), an outsider who is not in the group, a second group the user is not in, and one 300 expense split 150/150 between the two members. Everything is deleted on teardown. In CI, `.github/workflows/e2e.yml` runs on every successful Vercel Preview deployment, using the commit Vercel built. Each git branch has its own Neon database, created by the Neon Vercel integration, and Vercel exposes that URL only as a value CI cannot read. So the workflow looks up the branch's connection URI through the Neon API (the repo secret `NEON_API_KEY` and the repo variable `NEON_PROJECT_ID`), by the deployment's branch name, and sets `E2E_DATABASE_URL` from it. That keeps the seeded rows in the same database the preview reads.

**Database-level behaviour is tested in E2E, not vitest.** There are no vitest integration tests against a real Postgres on purpose: `src/db` speaks Neon's WebSocket driver, so a plain CI Postgres can't serve it, while each preview already has its own Neon database. A transaction whose risk is the SQL itself (bulk `UPDATE … FROM (VALUES …)`, unique keys, row locks) gets an API-driven spec that asserts on the rows through `dbPool`, like `e2e/member-merge-db.spec.ts` for `mergeUserInto`. Shared API and row helpers (`signedInPage`, `addExpense`, `balances`, `mergedBalances`, `legs`) live in `e2e/helpers.ts`.

**New features need E2E cases.** A change that alters a user-visible `/app` or `/mini` flow (a page, a form, a balance or settle-up rule, or an API the UI depends on) adds or updates a case in `e2e/` in the same PR. Test names are in English; the UI strings they match stay in Chinese. Each case seeds its own data through `e2e/fixtures.ts` and removes it on teardown, so no case depends on another's state.

Each E2E run posts its result to the PR through `scripts/e2e-pr-comment.mjs`. It is one comment, updated in place on every run (marked `<!-- e2e-results -->`), listing pass, fail, skip and flaky counts per spec and the first lines of each failure. A failing run still posts, then fails the job.
