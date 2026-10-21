import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

/**
 * Brings the test database to the current schema and empties it, once per
 * `jest` run. Without `TEST_DATABASE_URL` it does nothing, and the integration
 * specs fail with the instructions (see `test-app.ts`).
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    return;
  }

  const prismaCli = join(
    dirname(require.resolve('prisma/package.json')),
    'build/index.js',
  );
  // `migrate deploy` creates the database when it does not exist yet.
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('TRUNCATE "User" CASCADE');
  } finally {
    await client.end();
  }
}
