# ElysiaJS Production API Boilerplate

A reusable, production-ready API starter built on **ElysiaJS + Bun**: Drizzle ORM
(PostgreSQL), JWT auth with a permission model + email verification (OTP) +
password reset + refresh-token reuse detection, Redis caching, a BullMQ
background-job queue, SMTP email, structured logging, Prometheus metrics, an audit
log, rate limiting, security headers, XSS sanitization, centralized errors,
OpenAPI docs, tests, Docker and CI.

## Stack

- **Runtime:** Bun
- **Framework:** ElysiaJS
- **Database:** PostgreSQL via Drizzle ORM (`drizzle-typebox` bridges schemas → validation)
- **Cache:** Redis (Bun's built-in client) — caching + OTP storage
- **Queue:** BullMQ (Redis) — background jobs (email) with retries; separate worker process
- **Email:** SMTP via nodemailer (Mailtrap-ready); logs to console in dev without creds
- **Logging:** Pino — pretty in dev, JSON in prod (stdout → any log aggregator); `LOG_LEVEL` configurable
- **Rate limiting:** elysia-rate-limit (Redis-backed) — per-IP and per-user, opt-in per group
- **Auth:** Access JWT (zero-downtime secret rotation via `JWT_SECRET_PREVIOUS`) + opaque rotating refresh tokens (hashed + family-tracked with reuse detection) + Bearer, `Bun.password` (argon2id) hashing, permission model, email verification (OTP), password reset, optional TOTP 2FA (authenticator apps)
- **Observability:** Prometheus `/metrics`, opt-in OpenTelemetry tracing (`OTEL_ENABLED`, OTLP/HTTP export + `traceId` in logs), deep `/ready` probe, append-only audit log for sensitive actions (with configurable retention), ops alert webhook for permanently failed jobs
- **Hardening:** boot-time dependency fail-fast, security headers, request body-size limit, per-query statement timeout, deadline-bounded Redis ops, configurable Postgres pool
- **Docs:** OpenAPI at `/openapi`
- **Quality:** Biome (lint + format), `bun test` (CI enforces an 80% coverage floor)
- **Load testing:** k6 smoke journey in [load/](load/) (`BASE_URL`/`VUS`/`DURATION`-configurable)

## Quick start

```bash
# 1. Install deps
bun install

# 2. Configure environment
cp .env.example .env        # then edit secrets

# 3. Start local infra (Postgres + Redis) — API runs on the host
docker compose up -d

# 4. Create tables
bun run db:generate          # generate migration from schema (commit the output)
bun run db:migrate           # apply migrations

# 5. Run the API (and, in another terminal, the background worker)
bun run dev                  # http://localhost:3000  ·  docs at /openapi
bun run worker               # processes email jobs from the queue
```

## Project structure

```
src/
├── index.ts          # entry point: listen (body/idle limits) + graceful shutdown
├── app.ts            # composed app (no listen) — imported by tests
├── config/env.ts     # TypeBox-validated environment (fails fast at boot)
├── db/               # Drizzle: schema/ + model/ (per-table), client, utils, seed.ts
├── plugins/          # security-headers, cors, openapi, error, logger, metrics, health, auth, rate-limit (each named)
├── modules/          # feature modules (auth, user) — each = controller/service/model
├── queue/            # BullMQ: email + maintenance (token-cleanup) queues, worker runtime
├── worker.ts         # background worker entrypoint
└── lib/              # shared helpers (errors, time, permissions, cache, mailer, logger, sanitize, ip, hash, audit)
test/                 # bun:test integration tests via app.handle()
```

Background jobs run in a separate worker process (`bun run worker`). In tests the
queue uses an inline "sync" driver, so no worker/Redis is needed.

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Dev server with hot reload |
| `bun run worker` | Background job worker (email queue) |
| `bun run start` | Run without watch |
| `bun test` | Run tests (needs Postgres + Redis) |
| `bun run build` / `build:worker` | Compile the API / worker to a standalone binary |
| `bun run db:generate` | Generate a migration from the schema |
| `bun run db:migrate` | Apply migrations |
| `bun run db:push` | Push schema directly (dev convenience) |
| `bun run db:seed` | Create/promote the admin user (`SEED_ADMIN_*`) — idempotent |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run lint` / `lint:fix` | Lint with Biome |
| `bun run format` | Format with Biome |

## API overview

- `GET /health` — liveness (shallow) · `GET /ready` — readiness (deep: Postgres + Redis)
- `GET /metrics` — Prometheus metrics (keep internal / behind ingress)
- `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` — public
- `POST /auth/password/request-reset` · `POST /auth/password/reset` — public (forgotten password)
- `GET /auth/me` · `POST /auth/logout` — authenticated
- `POST /auth/email/request-otp` · `POST /auth/email/verify` — authenticated (email verification via OTP)
- `POST /auth/2fa/setup` · `/2fa/enable` · `/2fa/disable` — authenticated (TOTP) · `POST /auth/2fa/verify` — public (completes an MFA login challenge)
- `GET /users` · `GET /users/:id` · `PATCH`/`DELETE /users/:id` — permission-gated (self or admin; role changes admin-only; DELETE is a soft delete that revokes sessions and frees the email)

Authenticate by sending `Authorization: Bearer <accessToken>`. With
`AUTH_TRANSPORT=cookie` the refresh token moves to an httpOnly cookie
(`Path=/auth`, `SameSite=Strict`) instead of the JSON body — pair it with a
restricted `CORS_ORIGIN` in production. Set `REQUIRE_VERIFIED_EMAIL=true` to
make email verification mandatory: unverified users get 403
`EMAIL_NOT_VERIFIED` on protected routes (except `/auth/me`, `/auth/logout`,
`/auth/email/*`) and registration auto-emails the OTP.

## Docker

```bash
# Dev: infra only (Postgres + Redis). API + worker run on host via `bun run dev` / `bun run worker`.
docker compose up -d

# Full stack (API + worker + Postgres + Redis), e.g. for staging:
JWT_SECRET=... docker compose -f docker-compose.prod.yml up --build
```

The production image is a distroless container running a compiled binary.
Run migrations against the database separately (see `docker-compose.prod.yml`).

## Start a new project from this template

1. Copy the repo (or use it as a GitHub template) and `bun install`.
2. Rename the project: `name` in [package.json](package.json), and the API
   `title` / `description` in [src/plugins/openapi.ts](src/plugins/openapi.ts).
3. `cp .env.example .env` and set real values — at minimum `JWT_SECRET`
   (`openssl rand -hex 32`), `DATABASE_URL`, and a restricted
   `CORS_ORIGIN` for production. Set `SEED_ADMIN_*` if you'll seed an admin.
4. `docker compose up -d` → `bun run db:migrate` → `bun run db:seed` (optional
   first admin) → `bun run dev`.
5. Add your own tables under `src/db/schema/` + `src/db/model/` and features
   under `src/modules/` following the recipe below.

## Adding a new module

See [AGENTS.md](AGENTS.md) for the module recipe and the ElysiaJS conventions
this project follows.
