import type { Abstract, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { AuthModule } from '../auth/auth.module';
import { Clock } from '../common/clock';
import { PrismaService } from '../database/prisma.service';
import { Mailer } from '../mail/mailer';
import { RecordingMailer } from '../mail/recording.mailer';

/** A clock the test moves by hand. */
export class FakeClock extends Clock {
  private current = new Date('2026-10-20T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** A provider a spec replaces, beyond the mailer and the clock. */
export interface ProviderOverride {
  provide: Type | Abstract<unknown>;
  useValue: unknown;
}

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  mailer: RecordingMailer;
  clock: FakeClock;
}

/**
 * The real app against `TEST_DATABASE_URL`, with the recording mailer and a
 * fake clock. Fails — never skips — when the database is not configured.
 */
export async function createTestApp(
  controllers: Type[] = [],
  overrides: ProviderOverride[] = [],
): Promise<TestApp> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration specs need PostgreSQL: run ' +
        '`bun run db:setup` and set TEST_DATABASE_URL in apps/api/.env ' +
        '(see apps/api/.env.example).',
    );
  }
  process.env.DATABASE_URL = url;

  const mailer = new RecordingMailer();
  const clock = new FakeClock();
  const builder = Test.createTestingModule({
    // AuthModule again, so `controllers` can use its guards.
    imports: [AppModule, AuthModule],
    controllers,
  })
    .overrideProvider(Mailer)
    .useValue(mailer)
    .overrideProvider(Clock)
    .useValue(clock);
  for (const { provide, useValue } of overrides) {
    builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), mailer, clock };
}

let sequence = 0;

/** An address no other test, in any file, uses. */
export function uniqueEmail(label: string): string {
  sequence += 1;
  const nonce = `${process.pid}-${Date.now()}-${sequence}`;
  return `${label}-${nonce}@example.test`;
}

/** The `token` query parameter of the one link in a recorded email. */
export function tokenFromLink(link: string | undefined): string {
  if (!link) {
    throw new Error('The email carries no link');
  }
  const token = new URL(link).searchParams.get('token');
  if (!token) {
    throw new Error(`No token in ${link}`);
  }
  return token;
}
