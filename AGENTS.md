# AGENTS.md — conventions for this codebase

Production ElysiaJS + Bun API boilerplate. This file is the contract for
extending it (by humans or AI agents). Follow it exactly — the patterns exist
to preserve Elysia's end-to-end type safety.

## Setup (clone → running)

```bash
bun install
cp .env.example .env          # then set real JWT secrets (openssl rand -hex 32)
docker compose up -d          # local infra (Postgres) — the API runs on the host
bun run db:migrate            # apply existing migrations
bun run dev                   # http://localhost:3000 · docs at /openapi
```

## Commands

```bash
bun run dev        # hot-reload dev server
bun test           # tests (needs a running Postgres — `docker compose up -d`)
bun run lint:fix   # Biome lint + format (run before committing)
bun run build      # compile to ./server binary
```

Database workflow: edit `src/db/schema.ts` → `bun run db:generate` → `bun run db:migrate`.

## Architecture

```
src/
├── app.ts            # composes all plugins + modules (no .listen)
├── index.ts          # .listen + graceful shutdown
├── config/env.ts     # validated env — import { env } from here, never read process.env directly
├── db/               # schema/ (table per file), model/ (typebox per file), index.ts (client), utils.ts
│                      #   schema/ and model/ are symmetric: each table has a file in both, re-exported by a barrel index.ts
├── queue/            # BullMQ: connection, defineQueue, runtime, email queue
├── worker.ts         # background worker entrypoint (separate process)
├── plugins/          # cross-cutting: cors, openapi, error, logger, auth
├── modules/<feature>/  # index.ts (routes) · service.ts (logic) · model.ts (schemas)
└── lib/              # errors, time, permissions, cache (Redis), mailer, logger (Pino)
```

## Adding a new module (recipe)

Copy `src/modules/user/` and adapt:

1. **`model.ts`** — TypeBox schemas. Compose from `dbSchema` columns
   (`src/db/model.ts`) when the shape mirrors a table. Export one object.
2. **`service.ts`** — `export abstract class XService` with **static** methods.
   All DB access and request-independent logic lives here. Throw the error
   classes from `lib/errors.ts` (e.g. `NotFoundError`) — don't return ad-hoc
   error shapes.
3. **`index.ts`** — `export const xModule = new Elysia({ prefix: '/x', tags: ['X'] })`
   `.use(authPlugin)` (if protected) `.model(xModel)` then the routes. The
   Elysia instance **is** the controller.
4. Register it in `src/app.ts`: `.use(xModule)`.
5. Add the tag to `src/plugins/openapi.ts` `documentation.tags`.

## Environment variables

`config/env.ts` is the single source of truth and is validated at boot (the
process exits on missing/invalid values). To add a variable:

1. Add it to the `EnvSchema` `t.Object({...})` in `src/config/env.ts` (with a
   `default` if optional).
2. Add it to `.env.example` with a comment.
3. Import it via `import { env } from '../config/env'` — **never** read
   `process.env` directly outside `config/env.ts` (the one exception is
   `drizzle.config.ts`, which reads `DATABASE_URL` to stay decoupled).

## Database & migrations

- Tables live in `src/db/schema/`, **one file per table** (or per cohesive
  group). Add the new file, then re-export it from `src/db/schema/index.ts` and
  register it in the `table` singleton. FKs across tables import the referenced
  table file directly (e.g. refresh-tokens → users) — this keeps relations
  explicit without circular module imports.
- `src/db/model/` mirrors `src/db/schema/` one-to-one: for each new table add a
  matching `model/<table>.ts` exporting its `<table>Columns = { insert, select }`
  (use `spread()` from `db/utils.ts`; put column refinements like `email` format
  here), re-export it from `model/index.ts`, and register it in `dbSchema`.
  Feature modules compose request/response schemas from `dbSchema` — never
  hand-redeclare columns.
- Migrations in `drizzle/` are **committed to git** — they're part of the schema history.
- **Never edit an already-applied migration.** Change the schema files, then run
  `bun run db:generate` to produce a new migration, and `bun run db:migrate` to
  apply it.
- `bun run db:push` is for quick local iteration only — don't use it as the path
  to production schema changes.

## Testing

- Tests live in `test/` and run with `bun test`. They are **integration tests
  that require a running Postgres** (`docker compose up -d` first).
- Drive the app in-process via `app.handle(new Request(...))` (see
  `test/helpers.ts`) — don't start a real HTTP server.
- Run a single file: `bun test test/auth.test.ts`. Filter by name: `bun test -t "logs in"`.
- Use `uniqueEmail()` for data isolation so tests don't collide across runs.

## Error responses

The `error` plugin (`src/plugins/error.ts`) maps everything to a consistent
shape — match it; don't invent new shapes:

```json
{ "error": "NOT_FOUND", "message": "User not found" }        // domain errors
{ "error": "VALIDATION", "message": "...", "details": [...] } // request validation
```

Throw `AppError` subclasses from services (`BadRequestError`, `UnauthorizedError`,
`ForbiddenError`, `NotFoundError`, `ConflictError`). Validation (400),
not-found-route (404) and parse (400) are handled automatically.

## Auth

- Two tokens: short-lived **access** (`JWT_ACCESS_EXP`, default 15m) and a
  **rotating refresh** token (`JWT_REFRESH_EXP`, default 7d) persisted in
  `refresh_tokens`.
- `/auth/refresh` consumes (deletes) the presented refresh token and issues a
  new pair — reusing an old one returns 401.
- **Every refresh token must carry a unique `jti`** (`crypto.randomUUID()`) when
  signed. Without it, two tokens signed for the same user in the same second are
  byte-identical and violate the `token` unique constraint.
- Route guards (macros from `plugins/auth.ts`), simplest → most flexible:
  - `{ isAuthed: true }` — any authenticated user.
  - `{ hasRole: 'admin' }` — exact role gate.
  - `{ can: { action: '<model>:<operation>', ownParam? } }` — **permission gate**
    (preferred for resources). All add a typed `user` to the context; `can` also
    adds `scope: 'all' | 'own'`.
  - `{ verifiedEmail: true }` — requires a verified email (checks the DB fresh).
    Not applied to any route yet — opt in where needed.
- **Email verification (OTP):** users start unverified (`emailVerifiedAt = null`,
  exposed as the derived `emailVerified` boolean). `POST /auth/email/request-otp`
  emails a 6-digit code (stored hashed in Redis, 10m TTL, 60s resend cooldown,
  5-attempt cap); `POST /auth/email/verify` checks it and sets `emailVerifiedAt`.
  Logic in [modules/auth/otp.service.ts](src/modules/auth/otp.service.ts).

## Logging

- Structured logging via **Pino** ([src/lib/logger.ts](src/lib/logger.ts)). Dev →
  human-readable (pino-pretty); prod → single-line JSON on stdout (for
  Loki/Datadog/CloudWatch); tests → silent. Level via `LOG_LEVEL`.
- **Never use `console.*`** — use `logger` (app-wide) or a child logger. The one
  exception is [config/env.ts](src/config/env.ts), which runs before the logger exists.
- In request handlers/services, prefer the request-scoped `log` from the context
  (added by [plugins/logger.ts](src/plugins/logger.ts)) — it carries `requestId`
  for correlation: `({ log }) => log.info({ userId }, "did a thing")`. Outside a
  request, use the root `logger` or `createLogger({ module: "..." })`.
- Pass structured fields as the first arg, message second:
  `logger.error({ err, jobId }, "queue job failed")`. Secrets (auth header,
  password, tokens) are redacted automatically.

## Caching (Redis)

- Bun's built-in `RedisClient` via [src/lib/cache.ts](src/lib/cache.ts) — no extra
  dependency. Import the `cache` helper (`get/set(key,val,ttl?)/del/incr/expire/
  exists`); it's reusable, not OTP-specific.
- Key convention: `"<domain>:<name>:<id>"` (e.g. `otp:verify:<userId>`).
- `REDIS_URL` env (default `redis://localhost:6379`); Redis runs in
  `docker compose up -d`. The client is closed on graceful shutdown.

## Email

- [src/lib/mailer.ts](src/lib/mailer.ts) is the **delivery layer** —
  `mailer.send(...)`. Transport via `MAIL_TRANSPORT`: `auto` (default — **log in
  development, SMTP in production**), or force `log`/`smtp`. SMTP uses **nodemailer**
  (`SMTP_*` env; Mailtrap-ready) and falls back to console log if creds are
  missing. Tests use a **no-op capture**. Every send is recorded in an in-memory
  `outbox` (tests read it via `lastTo`). To develop against a real inbox set
  `MAIL_TRANSPORT=smtp` + Mailtrap creds. The `log` transport can be swapped for a
  structured logger later.
- **Don't call `mailer.send` from request handlers** — enqueue instead:
  `emailQueue.add({ to, subject, text })`. Only the worker (or the sync driver)
  delivers.

## Queues (BullMQ)

Slow/external work (email, and future jobs like SMS or webhooks) runs as
background jobs so requests return fast and failures retry.

- **Producers** call `<queue>.add(data)` (e.g. [queue/email.queue.ts](src/queue/email.queue.ts)).
  **Consumers** are BullMQ workers started from [src/worker.ts](src/worker.ts), a
  separate process — run `bun run worker` in dev; a dedicated container in prod.
- Define a queue with `defineQueue<T>(name, processor, defaultJobOpts?)`
  ([queue/define.ts](src/queue/define.ts)). The same `processor` powers both the
  worker and the inline driver, so there's one place that handles a job. Jobs
  default to 3 attempts with exponential backoff.
- **Driver** ([queue/connection.ts](src/queue/connection.ts)): `redis` (BullMQ) in
  dev/prod; `sync` (inline, no worker/Redis) forced in tests — so `.add()` runs the
  processor immediately and existing tests stay synchronous. Set via `QUEUE_DRIVER`.
- **New queue recipe:** add `queue/<name>.queue.ts` with
  `export const xQueue = defineQueue<XJob>("x", (data) => handler(data))`, register
  it in `src/worker.ts` (`startWorker(xQueue)`), and close its producer in
  `index.ts` shutdown. Producers just `xQueue.add(...)`.

## Permissions

Permission strings are `<model>:<operation>:<scope>` (e.g. `user:update:own`),
defined in [src/lib/permissions.ts](src/lib/permissions.ts).

- **scope `all`** → may act on any record; **scope `own`** → only records the
  requester owns.
- `ROLE_PERMISSIONS` maps each role to its grants (`'*'` = superuser, all at
  `all` scope). The JWT carries only `role`; permissions are resolved per request
  via `resolveScope(role, model, operation)` — change a role's grants and it
  takes effect immediately, no token reissue.
- The `can` macro resolves the granted `scope`. With `ownParam` it enforces
  param-based ownership for "own" scope (route param === user id); admins ("all")
  bypass. For row-level ownership (e.g. `post.userId`), use the resolved `scope`
  inside the handler/service to filter.
- **Field-level rules go in the handler**, keyed on `scope` — e.g. user PATCH
  rejects changing `role` unless `scope === 'all'` (see
  [modules/user/index.ts](src/modules/user/index.ts)). Keep services pure; the
  controller decides authorization.
- To grant a new resource's permissions, add `'<model>:<op>:<scope>'` entries to
  the relevant role in `ROLE_PERMISSIONS`.

## Gotchas

- **`await` DB queries in handlers.** Drizzle query builders are *thenables*, not
  native Promises. Returning one straight from a route makes Elysia's response
  validation run on the unresolved query (array responses fail with a confusing
  "Expected object"). Service methods are `async`; `await` them in the handler so
  the response schema validates resolved data.

## Code style

- Biome enforces formatting (2-space indent, double quotes, semicolons, 80 cols)
  and import organization. Run `bun run lint:fix` before committing; CI fails on
  lint errors.
- Use `import type` for type-only imports (`verbatimModuleSyntax` is on).

## ElysiaJS rules (do)

- **Chain everything.** Never split `const app = new Elysia(); app.get(...)` —
  it loses types. One fluent chain per instance.
- **Name plugins** with `new Elysia({ name: '...' })` so they dedupe across `.use()`.
- **Validate with TypeBox `t`.** One schema = runtime validation + type + OpenAPI.
  Reference models by string via `.model({...})`.
- **Single source of truth for data shapes:** derive from `dbSchema`
  (drizzle-typebox), don't hand-redeclare table fields. Declare a variable for
  a drizzle-typebox schema before composing it (avoids "infinite type" errors).
- **Errors:** throw `AppError` subclasses from services; the `error` plugin maps
  them. Don't add per-route try/catch for domain errors.
- **Keep composition roots explicit.** `app.ts` (`.use(xModule)` per module) and
  the `tags` list in `plugins/openapi.ts` grow one line per module by design —
  don't auto-discover/auto-load modules. Explicit `.use()` chaining is what
  preserves Elysia's end-to-end type inference.

## Don't

- Don't type `Context` manually or write traditional controller classes.
- Don't break the method chain.
- Don't create unnamed business plugins (they re-run on every `.use()`).
- Don't read `process.env` outside `config/env.ts`.
- Don't select/return `passwordHash` — use the `publicColumns` pattern.
- Don't edit `.agents/skills/` — it's the vendored ElysiaJS reference docs
  (generated, read-only). Read it for guidance, but never modify it.
