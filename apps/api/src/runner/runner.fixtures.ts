import type { User } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SessionService } from '../auth/session.service';
import { SESSION_COOKIE } from '../auth/session-cookie';
import { generateToken, hashToken } from '../auth/tokens';
import { type TestApp, uniqueEmail } from '../test/test-app';
import type { DeviceAuthorization } from './device-code.service';
import { RUNNER_TOKEN_PREFIX } from './runner-token';

/** Helpers the runner integration specs share. Test code only. */

export const MACHINE = {
  hostname: 'build-box',
  os: 'linux 6.19.10',
  cliVersion: '0.4.0',
};

export interface SignedIn {
  user: User;
  /** The `df_session=<token>` pair to send as a Cookie header. */
  cookie: string;
}

/**
 * A user with a live session, made directly: the sign-up routes share the
 * per-IP budget the device-code endpoint also spends.
 */
export async function signedInUser(
  t: TestApp,
  label: string,
  verified = true,
): Promise<SignedIn> {
  const user = await t.prisma.user.create({
    data: {
      email: uniqueEmail(label),
      emailVerifiedAt: verified ? t.clock.now() : null,
    },
  });
  const { token } = await t.app.get(SessionService).create(user.id, undefined);
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

export async function requestCode(http: App): Promise<DeviceAuthorization> {
  const res = await request(http)
    .post('/runner/device/code')
    .send(MACHINE)
    .expect(200);
  return res.body as DeviceAuthorization;
}

export function poll(http: App, deviceCode: string) {
  return request(http).post('/runner/device/token').send({ deviceCode });
}

export function approve(
  http: App,
  cookie: string,
  userCode: string,
  name = 'My laptop',
) {
  return request(http)
    .post(`/runner/device/${userCode}/approve`)
    .set('Cookie', cookie)
    .send({ name });
}

export interface Paired {
  token: string;
  runnerId: string;
}

/** The whole flow: code, approval by `owner`, first poll. */
export async function pair(
  http: App,
  owner: SignedIn,
  name = 'My laptop',
): Promise<Paired> {
  const code = await requestCode(http);
  await approve(http, owner.cookie, code.userCode, name).expect(204);
  const res = await poll(http, code.deviceCode).expect(200);
  return { token: res.body.token, runnerId: res.body.runnerId };
}

/** Machines inserted directly, for the limit: pairing 20 would hit the IP limit. */
export async function insertRunners(
  t: TestApp,
  userId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const runner = await t.prisma.runner.create({
      data: {
        userId,
        name: `machine ${i}`,
        os: MACHINE.os,
        cliVersion: MACHINE.cliVersion,
        tokenHash: hashToken(`${RUNNER_TOKEN_PREFIX}${generateToken()}`),
      },
    });
    ids.push(runner.id);
  }
  return ids;
}
