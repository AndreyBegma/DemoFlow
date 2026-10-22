# Sign-up, sign-in, email verification and password reset pages

Issue: [#124](https://github.com/AndreyBegma/DemoFlow/issues/124) · Phase 5 ·
Sign-in slice 2 of 3 · Specs: [120](120-accounts-api.md) (the API),
[121](121-i18n-dictionary.md) (UI strings) · Vision §9 (Glass UI)

Depends on #120
Depends on #121

## Summary

#120 gives the API its accounts and #121 gives the web app its dictionary.
This slice adds the pages a person uses:

- sign up;
- sign in;
- verify the email;
- reset a forgotten password;
- `/app`, a protected shell that later Phase 5 work (Runner pairing, projects)
  grows into.

## Scope

### In scope

- **Routes** in `apps/web/src/app/`. "Public" means the page renders without a
  session.

  | Route | Access | What it does |
  |---|---|---|
  | `/sign-up` | public | Email and password form. On success it shows "check your email" |
  | `/sign-in` | public | Email and password form. On success it goes to `/app`. Links to sign-up and forgot password |
  | `/verify-email?token=` | public | Posts the token on load. Shows verified (link to `/app`) or invalid/expired (resend button when signed in) |
  | `/forgot-password` | public | Email form. Always shows the same "if an account exists, we sent a link" message |
  | `/reset-password?token=` | public | New password form. On success it shows "password changed, sign in" and links to `/sign-in` |
  | `/app` | signed in | Shows the email and a sign-out button. Unverified users also see a "verify your email" banner with resend. The empty state says projects will appear here |

- **Access rules.** A guest on `/app` is redirected to `/sign-in`. A signed-in
  user on `/sign-in` or `/sign-up` is redirected to `/app`.
- **API access is same-origin everywhere.**
  - Client code calls `fetch('/api/…', { credentials: 'same-origin' })`.
  - `next.config.ts` adds a rewrite `/api/:path*` → `${API_URL}/:path*`, which
    strips `/api` exactly as Caddy does on staging. Locally this makes
    `localhost:3670/api` reach the API on 8370.
  - Server components call `${API_URL}/auth/me`, forwarding the request's
    `cookie` header. `API_URL` is the internal origin: on staging the web
    container already has `API_URL=http://api:8370` [Confirmed:
    `deploy/staging/docker-compose.yml`].
- **API client.** `apps/web/src/lib/api.ts` is a thin typed client:
  - `signUp`, `signIn`, `signOut`, `me`, `verifyEmail`, `resendVerification`,
    `requestPasswordReset` and `confirmPasswordReset`;
  - one function per endpoint of spec 120;
  - errors mapped to a small union: `invalid`, `rate_limited`, `unknown`.
- **Glass UI only.** `Card`, `Input`, `Button` and the other existing
  primitives. One readable card form, centred like today's home page. Glass
  is only for chrome (vision §9). Field errors are shown inline. 429 shows
  "too many attempts, try again later".
- **Strings.** Every string goes through `t()` from #121, under `auth.*` and
  `app.*` keys.
- **Client validation** mirrors spec 120: the email format, and a password of
  10 to 128 characters. The server stays the authority.
- **GitHub button.** The sign-in and sign-up cards leave a slot for slice 3's
  "Continue with GitHub" button. Nothing is rendered in this slice.
- `apps/web/.env.example` documents `API_URL` (the internal API origin, default
  `http://localhost:8370`).

### Out of scope

- GitHub sign-in and account settings (slice 3), account deletion, and the
  landing page redesign (its own item).

## Decisions

1. **After sign-in the user lands on a minimal `/app`.** (owner, 2026-10-20)
   It is the shell that Runner pairing and projects attach to.
2. **API calls are same-origin `/api` everywhere, through a Next rewrite in
   development.** (owner) Local behaviour then matches staging: one origin, and
   the `SameSite=Lax` cookie and Origin check of spec 120 work unchanged.
3. **One Glass UI card per form.** (owner) There is no new design work.
4. **The session check runs on the server in `/app`'s layout**, not in
   middleware. (orchestrator) Middleware cannot reach the internal
   `API_URL` without extra configuration, and one layout guards every future
   `/app/**` page.
5. **No new dependency.** (orchestrator) Forms use React 19 actions and
   `useActionState`, with no form library.

## Acceptance criteria

- [ ] With api and web running locally (`bun run start:dev`), the PR shows
      screenshots of each step of this flow:
      1. sign up;
      2. the log mailer prints a link;
      3. open the link: verified;
      4. sign out, then sign in: `/app` with no banner;
      5. forgot password: the log link opens the reset page;
      6. set a new password and sign in.
- [ ] An unverified user on `/app` sees the banner. Resend gives a
      confirmation, and the log shows a second email.
- [ ] A guest opening `/app` is redirected to `/sign-in`. A signed-in user
      opening `/sign-in` is redirected to `/app`.
- [ ] A wrong password shows one generic error. A sixth attempt shows the
      rate-limit message.
- [ ] An expired or used verification or reset token shows the invalid-link
      state, never a crash.
- [ ] No user-facing string literal in `apps/web/src/app/**` or
      `apps/web/src/components/**`. Every string goes through `t()`.
- [ ] Keyboard only: every form can be completed and submitted. Labels are
      tied to inputs, and errors are announced (`aria-live`).
- [ ] At 375 px width, nothing scrolls horizontally (screenshot).
- [ ] `bun run check` and `bun run build` pass. Woodpecker is green. After the
      merge, staging shows `/sign-in`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i124 | the auth pages | apps/web/** | #120, #121 | yes | sonnet |

This is one slot. Every route, endpoint and string family is named here, so
it is `sonnet`.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/next.config.ts | i124 | do not open |
| bun.lock, apps/web/package.json | nobody: no new dependency | — |

## Risks

- **The cookie is not forwarded by the server-side `me` call** (medium):
  `/app` would redirect a signed-in user. Mitigation: an acceptance criterion
  covers it, and both the redirect and the stay paths are screenshotted.
- **The rewrite shadows a future Next route under `/api`** (low). Mitigation:
  `/api` is reserved for the API, and this is noted in `apps/web/README.md`.

## Open questions

- None. Visual details not settled here follow the existing home page card.
