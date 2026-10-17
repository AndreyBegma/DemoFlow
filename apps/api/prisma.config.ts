import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  // Not prisma's env(): it throws while the config loads, so `prisma generate`
  // — which never connects — failed in every checkout without apps/api/.env
  // (orchestrator worktrees, image builds). Commands that connect still fail
  // without it, with Prisma's own "datasource url" error.
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
