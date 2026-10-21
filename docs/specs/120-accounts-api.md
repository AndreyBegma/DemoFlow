# Accounts API: email/password sign-up, verification, reset and sessions

Issue: [#120](https://github.com/AndreyBegma/DemoFlow/issues/120) · Phase 5 ·
Sign-in slice 1 of 3 · Decisions:
[ADR-0006](../adr/0006-accounts-github-oauth-and-email-password.md),
[ADR-0008](../adr/0008-cloud-boundary.md)

## Summary

Phase 5 starts with accounts, in the order sign-in → Runner pairing → projects
→ demo library (roadmap). The API has no models and no auth today [Confirmed:
`apps/api/prisma/schema.prisma` declares no models; `apps/api/src` contains only
`health` and `database`]. This slice adds the user, the session and the emailed
tokens, the email/password flows over HTTP, and a mail service with a test
double. It ships no web pages (slice 2) and no GitHub sign-in (slice 3), and
every later cloud feature builds on the guards it adds.

## Scope

### In scope

- **Schema.** New tables `User`, `Session` and `EmailToken`, created in one
  migration named `accounts` (`prisma migrate dev --name accounts`).
- **Endpoints.** Sign-up, sign-in, sign-out, `me`, email verification, resend
  verification, password reset request and confirm (see API).
- **Sessions.** An opaque 256-bit token in an httpOnly cookie. The database
  stores only its SHA-256 hash. The session lasts 30 days, sliding.
- **Guards.** `SessionGuard` (requires a valid session) and `VerifiedGuard`
  (requires a verified email). Both are exported for every later module.
- **CSRF.** The cookie is `SameSite=Lax`, and an Origin check runs on every
  state-changing request.
- **Rate limiting.** Limits per IP and per email address on the auth endpoints.
- **Mail.** A `Mailer` interface with three implementations:
  - Resend;
  - a log mailer: staging without a key;
  - a recording test double: local and CI.
- **Configuration.** New environment variables, documented in
  `apps/api/.env.example` and `deploy/staging/env/api.env.example`.

### Out of scope

- Web pages (slice 2). The links in emails point at web routes that slice 2
  builds: `/verify-email` and `/reset-password`.
- GitHub OAuth and account linking (slice 3).
- Changing the email address, changing the password while signed in, account
  deletion (later Phase 5 items), teams (roadmap: personal accounts only).

## Decisions

1. **Opaque session token, hashed in the database**, not a JWT. (owner,
   2026-10-20) Sign-out, password reset and future account deletion revoke a
   session immediately. This mirrors the Runner credential in ADR-0007.
2. **30 days, sliding.** (owner) `expiresAt` moves forward when the session is
   used, at most once an hour, so a request does not cost a write. The cookie's
   `Max-Age` is refreshed when `expiresAt` moves.
3. **An unverified user can sign in, but reaches only `me`, resend verification
   and sign-out.** (owner) Every product endpoint after this slice uses
   `VerifiedGuard`. `me` returns `emailVerified: false`, so the web can show a
   "verify your email" state instead of a sign-in error.
4. **CSRF: `SameSite=Lax`, plus an Origin check.** (owner) On staging, web and
   API share one origin, with Caddy routing `/api` [Confirmed:
   `deploy/staging/env/api.env.example`]. Locally they are same-site on
   localhost. On `POST`/`PUT`/`PATCH`/`DELETE`, a request whose `Origin`
   header is present and differs from `WEB_URL` gets 403. A request with no
   `Origin` header (curl, server-to-server) passes, because without the
   cookie's `SameSite` protection there is no session to ride on.
5. **Passwords follow NIST.** (owner) 10 to 128 characters, no composition
   rules, no breach lookup. Hashing is argon2id (ADR-0006), with
   `@node-rs/argon2` defaults (prebuilt binaries, no node-gyp).
6. **Email links.** (owner) The verification link is valid for 24 h and the
   reset link for 1 h. Both work once. A successful reset revokes every session
   of that user and does not sign them in.
7. **Rate limits are in this slice**, using `@nestjs/throttler` with in-memory
   storage (one API instance). (owner) Limits:
   - per IP: 20 requests per 10 minutes across the auth endpoints;
   - per email address: 5 sign-in attempts per 15 minutes;
   - per email address: 3 verification or reset emails per hour.

   Past a limit the response is 429.
8. **No account enumeration.** (orchestrator, per ADR-0006's ownership stance)
   - Sign-up and reset request always return the same 202.
   - Sign-up with an email that already exists sends that address a "someone
     tried to sign up" notice instead of creating anything.
   - A failed sign-in is one generic 401, whether the email exists or not.
9. **Resend is optional below production.** (owner) Which mailer runs:
   - `RESEND_API_KEY` set: the Resend mailer;
   - no key, `APP_ENV` not `production`: the log mailer, which writes each
     message (recipient, subject, link) to the API log, with a warning at
     startup;
   - no key, `APP_ENV=production`: the API refuses to start;
   - tests: always the recording double.

   Staging runs `APP_ENV=production` today [Confirmed:
   `deploy/staging/env/api.env.example`], so the staging example sets
   `MAIL_TRANSPORT=log` explicitly until the owner adds a key. That
   variable overrides the selection above.
10. **No passport.** (orchestrator) The flows are small. A guard reading one
    cookie is less code than a passport strategy and keeps slice 3's OAuth
    explicit.

## Data / Schema

Migration `accounts`. Every table is new and nothing else is altered.

| Table | Columns |
|---|---|
| `User` | `id` (cuid), `email` (unique, stored lower-cased and trimmed), `passwordHash` (nullable: slice 3 adds GitHub-only users), `emailVerifiedAt` (nullable), `createdAt`, `updatedAt` |
| `Session` | `id`, `tokenHash` (unique), `userId` → `User` (cascade delete), `expiresAt`, `lastSeenAt`, `createdAt`, `userAgent` (nullable, truncated to 256 characters) |
| `EmailToken` | `id`, `tokenHash` (unique), `userId` → `User` (cascade delete), `purpose` (enum `VERIFY_EMAIL` \| `RESET_PASSWORD`), `expiresAt`, `usedAt` (nullable), `createdAt` |

No IP address is stored (ADR-0008: the cloud holds the minimum).

## API

All routes are under `/auth`. Bodies are DTOs with `class-validator`, per the
global `ValidationPipe`.

| Method and path | Body | Guard | Result |
|---|---|---|---|
| `POST /auth/sign-up` | `email`, `password` | none | 202 `{}`. Sends a verification email, or the "already registered" notice |
| `POST /auth/sign-in` | `email`, `password` | none | 200 `{ user }` plus `Set-Cookie`, or 401 |
| `POST /auth/sign-out` | none | session | 204. Deletes the session and clears the cookie |
| `GET /auth/me` | none | session | 200 `{ user: { id, email, emailVerified } }`, or 401 |
| `POST /auth/verify-email` | `token` | none | 204, or 400 for an invalid, used or expired token |
| `POST /auth/verify-email/resend` | none | session | 202. A no-op when already verified |
| `POST /auth/password-reset` | `email` | none | 202 `{}` |
| `POST /auth/password-reset/confirm` | `token`, `password` | none | 204. Revokes every session of the user. 400 for a bad token |

The cookie is `df_session`, with `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure`
when `APP_ENV=production`, and `Max-Age` equal to the session's remaining
lifetime. `main.ts` gains `cookie-parser`. CORS already allows `WEB_URL` with
credentials [Confirmed: `apps/api/src/main.ts`].

The email links are `${WEB_URL}/verify-email?token=…` and
`${WEB_URL}/reset-password?token=…`. A token is 256 random bits,
base64url-encoded. Only its SHA-256 hash is stored.

## Configuration

| Variable | Default | Where |
|---|---|---|
| `RESEND_API_KEY` | empty | `apps/api/.env.example` (empty), staging example (empty, filled by the owner) |
| `MAIL_FROM` | `DemoFlow <no-reply@localhost>` | both examples; the owner sets the verified domain |
| `MAIL_TRANSPORT` | unset (auto, per Decision 9) | staging example: `log` |

`SESSION_*` variables are not added: the lifetime and the cookie name are
constants.

## Acceptance criteria

- [ ] Sign-up → verification email recorded by the double → `verify-email` with
      its token → `me` shows `emailVerified: true` (integration test against
      the test database).
- [ ] Sign-up with an existing email returns the same 202 and body, and records
      the notice email, not a verification one.
- [ ] Sign-in with a wrong password, and with an unknown email, both return the
      same 401 body.
- [ ] Sign-out: the old cookie gets 401 on `me` afterwards.
- [ ] Reset: `password-reset` → confirm with the recorded token → every earlier
      session gets 401, the old password fails, the new one signs in. Reusing
      the token gives 400. A token older than 1 h gives 400 (clock injected).
- [ ] Verification token older than 24 h gives 400. A used token gives 400.
- [ ] Sliding expiry: a session used after 29 days is extended. One idle past 30
      days gets 401 (clock injected).
- [ ] `VerifiedGuard`: a test route behind it gives 403 for an unverified
      session and 200 for a verified one.
- [ ] **Authorization:** `me` with user A's cookie returns A and never B. A
      session token of A, hashed, never matches B's sessions. A reset token
      issued for A cannot change B's password.
- [ ] CSRF: `POST /auth/sign-out` with `Origin: https://evil.example` gets 403.
      With `Origin` equal to `WEB_URL` it gets 204.
- [ ] Rate limits: the sixth sign-in attempt for one email within 15 minutes
      gets 429. The fourth reset email within an hour is not sent.
- [ ] The database holds no plaintext token or password: assert on rows after
      sign-up, sign-in and reset.
- [ ] With `APP_ENV=production` and no key and no `MAIL_TRANSPORT`, the API
      fails to start with a message naming `RESEND_API_KEY`.
- [ ] Both env examples carry the new variables. `bun run check`, `bun run test`
      and `bun run build` pass. Woodpecker is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i120 | accounts in the API | apps/api/**, bun.lock, deploy/staging/env/api.env.example, deploy/README.md | — | yes | opus |

This is one slot. The schema, the guards and the mail service are one
contract, and every part of it is tested through the same flows. It is `opus`
because it writes the first schema and is the authentication boundary every
later cloud slice relies on.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, apps/api/prisma/migrations/** | i120 | do not open |
| bun.lock, apps/api/package.json | i120 | a parallel web slice must not add dependencies |

## Risks

- **A bypass of the session guard** (high): every later endpoint inherits it.
  Mitigation: the authorization tests above, and the guard tested on a route
  of its own.
- **argon2 native binary in the Docker image** (medium) [Unknown: the base
  image's libc]. Mitigation: `@node-rs/argon2` ships glibc and musl builds,
  and the PR's Woodpecker image build proves it.
- **A lost email on staging** (low): until the owner adds a Resend key, the
  log mailer prints the link to the API log.

## Open questions

- None. A detail the slot finds unsettled defaults to the stricter option, and
  is noted in the PR body.
