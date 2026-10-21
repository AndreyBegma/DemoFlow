import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import proxyAddr from 'proxy-addr';
import type { VerifyClientCallbackAsync } from 'ws';
import { RunnerAuthService } from './runner-auth.service';
import { RUNNER_SOCKET_PATH, type RunnerUpgradeRequest } from './runner-socket';

type TrustProxy = (address: string, hop: number) => boolean;

/**
 * `WsAdapter` with the runner socket's authentication on the upgrade itself:
 * an unknown, revoked or missing token is answered `401` and no socket ever
 * opens (spec #151). The machine and the client address ride on the request
 * to the gateway's `handleConnection`.
 */
export class RunnerSocketAdapter extends WsAdapter {
  private readonly log = new Logger(RunnerSocketAdapter.name);

  constructor(private readonly app: NestExpressApplication) {
    super(app);
  }

  create(
    port: number,
    options?: Record<string, unknown> & { path?: string },
  ): unknown {
    if (options?.path !== RUNNER_SOCKET_PATH) {
      return super.create(port, options);
    }
    return super.create(port, { ...options, verifyClient: this.verifier() });
  }

  private verifier(): VerifyClientCallbackAsync<RunnerUpgradeRequest> {
    const auth = this.app.get(RunnerAuthService);
    // The function Express compiled from `trust proxy` (#120), so the address
    // is the one `req.ip` would give an HTTP request.
    const trust: TrustProxy = this.app
      .getHttpAdapter()
      .getInstance()
      .get('trust proxy fn');

    return ({ req }, done) => {
      auth
        .authenticate(req.headers.authorization)
        .then((runnerAuth) => {
          if (!runnerAuth) {
            done(false, 401, 'Unauthorized');
            return;
          }
          req.runnerAuth = runnerAuth;
          req.runnerIp = proxyAddr(req, trust);
          done(true);
        })
        .catch((error: unknown) => {
          this.log.error(error);
          done(false, 500, 'Internal Server Error');
        });
    };
  }
}
