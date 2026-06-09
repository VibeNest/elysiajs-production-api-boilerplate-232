# ElysiaJS Production API Boilerplate

A reusable, production-ready API starter built on **ElysiaJS + Bun**, with
Drizzle ORM (PostgreSQL), JWT auth, centralized error handling, OpenAPI docs,
tests, Docker and CI.

## Stack

- **Runtime:** Bun
- **Framework:** ElysiaJS
- **Database:** PostgreSQL via Drizzle ORM (`drizzle-typebox` bridges schemas → validation)
- **Cache:** Redis (Bun's built-in client) — caching + OTP storage
- **Queue:** BullMQ (Redis) — background jobs (email) with retries; separate worker process
- **Email:** SMTP via nodemailer (Mailtrap-ready); logs to console in dev without creds
- **Logging:** Pino — pretty in dev, JSON in prod (stdout → any log aggregator); `LOG_LEVEL` configurable
- **Auth:** Custom JWT (access + rotating refresh) + Bearer, `Bun.password` (argon2id) hashing, permission model + email verification (OTP)
- **Docs:** OpenAPI at `/openapi`
- **Quality:** Biome (lint + format), `bun test`

## Quick start

```bash
# 1. Install deps
bun install

# 2. Configure environment
cp .env.example .env        # then edit secrets

# 3. Start local infra (Postgres) — API runs on the host
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
├── index.ts          # entry point: listen + graceful shutdown
├── app.ts            # composed app (no listen) — imported by tests
├── config/env.ts     # TypeBox-validated environment (fails fast at boot)
├── db/               # Drizzle: schema, client, drizzle-typebox models, utils
├── plugins/          # cors, openapi, error, logger, auth (each named for dedupe)
├── modules/          # feature modules (auth, user) — each = controller/service/model
├── queue/            # BullMQ email queue + worker runtime
├── worker.ts         # background worker entrypoint
└── lib/              # shared helpers (errors, time, cache, mailer, logger)
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
| `bun test` | Run tests (needs a running database) |
| `bun run build` | Compile to a standalone `./server` binary |
| `bun run db:generate` | Generate a migration from the schema |
| `bun run db:migrate` | Apply migrations |
| `bun run db:push` | Push schema directly (dev convenience) |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run lint` / `lint:fix` | Lint with Biome |
| `bun run format` | Format with Biome |

## API overview

- `GET /health` — liveness check
- `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` — public
- `GET /auth/me` · `POST /auth/logout` — authenticated
- `POST /auth/email/request-otp` · `POST /auth/email/verify` — authenticated (email verification via OTP)
- `GET /users` · `GET /users/:id` · `PATCH`/`DELETE /users/:id` — permission-gated (self or admin; role changes admin-only)

Authenticate by sending `Authorization: Bearer <accessToken>`.

## Docker

```bash
# Dev: infra only (Postgres). API runs on host via `bun run dev`.
docker compose up -d

# Full stack (API + Postgres), e.g. for staging:
JWT_SECRET=... JWT_REFRESH_SECRET=... docker compose -f docker-compose.prod.yml up --build
```

The production image is a distroless container running a compiled binary.
Run migrations against the database separately (see `docker-compose.prod.yml`).

## Adding a new module

See [AGENTS.md](AGENTS.md) for the module recipe and the ElysiaJS conventions
this project follows.
