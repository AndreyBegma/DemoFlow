# DemoFlow

## Requirements

- [Bun](https://bun.sh) 1.4.0+
- Node.js 24+
- Docker (for PostgreSQL)

## Getting started

```bash
bun install
bun run db:setup     # PostgreSQL on :5470, migrations, seed
bun run start:dev    # api → http://localhost:8370  ·  web → http://localhost:3670
```

Health check: `curl http://localhost:8370/health`

On a fresh clone, create the git-ignored env files first: copy `docker/.env.example` to `docker/.env` and `apps/api/.env.example` to `apps/api/.env`, and set the same database password in `POSTGRES_PASSWORD` and `DATABASE_URL`. `db:setup` stops with an error if `docker/.env` is missing.

## Workspaces

| Path | Package | Stack |
|---|---|---|
| `apps/api` | `@demoflow/api` | NestJS 11, Prisma 7, PostgreSQL |
| `apps/web` | `@demoflow/web` | Next.js 16, React 19, Tailwind CSS 4 |
| `packages/shared` | `@demoflow/shared` | shared TypeScript |

See `CLAUDE.md` for all commands and conventions.

## Branches and deployment

`main` holds releases; every pull request targets `develop`. A merge into
`develop` deploys https://staging-demoflow.luna-realm.com through Woodpecker —
see [deploy/README.md](deploy/README.md).

The product vision lives in [docs/product/vision.md](docs/product/vision.md).
