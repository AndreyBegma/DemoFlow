import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { RunnerSocketAdapter } from './runner/runner-socket.adapter';
import { originCheck } from './security/origin-check';

/** Everything `main.ts` puts around the app. Integration tests apply it too. */
export function configureApp(app: NestExpressApplication): void {
  const webUrl = process.env.WEB_URL ?? 'http://localhost:3670';

  // Staging: cloudflared → Caddy → API, all on private addresses. Trusting
  // only those makes `req.ip` the client for the per-IP rate limit, without
  // letting a client pick its own address through X-Forwarded-For.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.use(helmet());
  app.enableCors({ origin: webUrl, credentials: true });
  app.use(cookieParser());
  app.use(originCheck(webUrl));

  // The runner socket (`/runner`), authenticated on the upgrade.
  app.useWebSocketAdapter(new RunnerSocketAdapter(app));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
}
