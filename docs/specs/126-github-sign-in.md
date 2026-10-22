# Sign in with GitHub, and link or unlink GitHub in account settings

Issue: [#126](https://github.com/AndreyBegma/DemoFlow/issues/126) · Phase 5 ·
Sign-in slice 3 of 3 · Decisions:
[ADR-0006](../adr/0006-accounts-github-oauth-and-email-password.md) (rules 2
and 3), [ADR-0008](../adr/0008-cloud-boundary.md) · Specs:
[120](120-accounts-api.md), [124](124-sign-in-pages.md)

Depends on #120
Depends on #124

## Summary

ADR-0006 makes GitHub the second way to sign in, from the start. #120 gives
the API its users and sessions, and #124 gives the web app its sign-in cards
and `/app`. This slice adds the GitHub OAuth flow, linking by verified email,
and an account settings page to link or unlink GitHub.

## Scope

### In scope

- **Schema.** A new table `GithubIdentity`, in one migration named
  `github_identity`. No existing table is altered.
- **API endpoints** (under `/auth/github`):
  - `GET /auth/github/start?intent=sign-in|link`;
  - `GET /auth/github/callback`;
  - `DELETE /auth/github` (unlink, session required);
  - `GET /auth/me` gains `githubLinked: boolean` and `hasPassword: boolean`.
- **OAuth.** The authorization-code flow with `state` (and PKCE, which GitHub
  supports for OAuth apps), with scopes `read:user user:email`. The `state`
  and the PKCE verifier live in a short-lived (10 min) signed httpOnly cookie,
  `df_oauth`.
- **Account resolution** on callback, for `intent=sign-in`, applied in this
  order:
  1. A `GithubIdentity` with this GitHub user id exists: sign in as its user.
  2. Otherwise read the GitHub **primary verified** email (`/user/emails`).
     There is none: refuse with `github_no_verified_email`.
  3. A `User` with that email exists **and** its `emailVerifiedAt` is set:
     create the `GithubIdentity` for it (link) and sign in. This is ADR-0006
     rule 3.
  4. A `User` with that email exists but is **unverified**: refuse with
     `github_link_requires_verified`. The web shows "sign in with your password
     and link GitHub from settings".
  5. No such user: create a `User` with `emailVerifiedAt = now`, no password,
     and the identity, then sign in.
- **Linking from settings** (`intent=link`, session required):
  - attach the GitHub identity to the current user, whatever the emails;
  - refuse with `github_already_linked_elsewhere` when that GitHub account
    belongs to another user;
  - refuse when the current user already has a GitHub identity.
- **Unlink.**
  - Allowed only when the user has a password (`passwordHash` set). Otherwise
    the response is 409 `github_unlink_requires_password`, because a
    GitHub-only user would be locked out.
  - A GitHub-only user sets a password through the existing forgot-password
    flow of #120 and #124. There is no new UI for that.
- **Web.**
  - A "Continue with GitHub" button in the slot that #124 left on `/sign-in`
    and `/sign-up`. It is rendered only when the API reports GitHub as
    configured.
  - `/app/settings`, linked from `/app`, shows the email, the GitHub status,
    and Link or Unlink. Unlink is disabled, with an explanation, when there is
    no password.
  - Error codes from the callback redirect, `/sign-in?error=<code>` or
    `/app/settings?error=<code>`, are shown as `t()` messages.
- **Configuration.** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, empty by
  default. While either is empty, `GET /auth/github/start` returns 404, and
  `GET /auth/providers` returns `{ github: false }`, so the web hides the
  button.

### Out of scope

- Repository access, GitHub Apps, and storing the GitHub access token.
- Changing the password in settings, changing the email, account deletion.

## Decisions

1. **Settings cover only linking and unlinking GitHub.** (owner, 2026-10-20) A
   GitHub-only user sets a password through "forgot password".
2. **Scopes are `read:user user:email`, and the token is not stored.** (owner,
   ADR-0008: the cloud holds the minimum.) The access token is used during the
   callback to read the profile and emails, then dropped.
3. **A new person signing in with GitHub gets an account immediately**, with a
   verified email and no password. A GitHub account without a verified primary
   email is refused. (owner)
4. **Linking by email follows ADR-0006 rule 3 exactly.** (ADR-0006) Both emails
   must be verified. Explicit linking from settings needs no email match,
   because the person proved both identities in one session.
5. **Without credentials the slice merges, and GitHub sign-in stays hidden.**
   (owner, as with Resend in #120) The owner creates the GitHub OAuth App with
   callback URL `https://demoflow-app.luna-realm.com/api/auth/github/callback`
   (local: `http://localhost:3670/api/auth/github/callback`) and puts the id
   and secret in `env/api.env` on the host.
6. **The GitHub email is stored only through `User.email`.** (orchestrator) The
   identity row holds the GitHub user id and login, nothing else.

## Data / Schema

Migration `github_identity`. The table is new and nothing is altered.

| Table | Columns |
|---|---|
| `GithubIdentity` | `id`, `userId` → `User` (unique: one GitHub identity per user; cascade delete), `githubUserId` (unique, the numeric id as a string), `login`, `createdAt` |

## API

| Method and path | Guard | Result |
|---|---|---|
| `GET /auth/providers` | none | `{ github: boolean }` |
| `GET /auth/github/start?intent=sign-in\|link` | `link` needs a session | 302 to GitHub, with the `df_oauth` cookie set. 404 when not configured |
| `GET /auth/github/callback?code&state` | `df_oauth` must match `state` | 302 to `${WEB_URL}/app` (sign-in), `${WEB_URL}/app/settings` (link), or the error redirect. Sets `df_session` on sign-in |
| `DELETE /auth/github` | session | 204, or 409 `github_unlink_requires_password` |

GitHub HTTP calls go through one injectable `GithubClient`
(`exchangeCode`, `getUser`, `getEmails`), and tests replace it with a fake. No
test reaches github.com.

## Configuration

| Variable | Default | Where |
|---|---|---|
| `GITHUB_CLIENT_ID` | empty | `apps/api/.env.example`, `deploy/staging/env/api.env.example` |
| `GITHUB_CLIENT_SECRET` | empty | same |

## Acceptance criteria

Each of these is an integration test with the fake `GithubClient`, unless it
says otherwise.

- [ ] A new GitHub user with a verified primary email gets an account with a
      verified email and no password, and a session. `me` shows
      `githubLinked: true, hasPassword: false`.
- [ ] An existing **verified** email account signing in with GitHub (same
      email, verified on GitHub) is linked and signed in, and no second user
      is created.
- [ ] An existing **unverified** account: GitHub sign-in is refused with
      `github_link_requires_verified`, and no identity is created.
- [ ] A GitHub account with no verified primary email is refused with
      `github_no_verified_email`.
- [ ] A returning GitHub user is matched by `githubUserId`, even after changing
      their GitHub email.
- [ ] A `state` mismatch, or a missing `df_oauth` cookie, gives an error
      redirect and no session.
- [ ] Link from settings attaches the identity. Linking a GitHub account
      already owned by user B, while signed in as A, is refused, and B keeps
      it (**authorization test**).
- [ ] Unlink with a password gives 204. Unlink without one gives 409.
- [ ] Unset credentials: `/auth/providers` gives `{ github: false }`, `start`
      gives 404, and the web hides the button (screenshot).
- [ ] The GitHub access token never appears in the database or the logs
      (assert on rows, and on a log spy).
- [ ] Web: `/app/settings` shows both states and every error message through
      `t()`. Keyboard is usable. 375 px width has no horizontal scroll
      (screenshots).
- [ ] Both env examples carry the variables. The PR body gives the owner the
      callback URLs. `bun run check`, `bun run test` and `bun run build` pass.
      Woodpecker is green.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i126 | GitHub sign-in, API and web | apps/api/**, apps/web/**, bun.lock, deploy/staging/env/api.env.example, deploy/README.md | #120, #124 | yes | opus |

This is one slot. The callback's redirects and error codes are one contract
between the API and the web, and splitting it would serialize two small slots
anyway. It is `opus` because it is the account-linking boundary, where a
mistake is an account takeover.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, apps/api/prisma/migrations/** | i126 | do not open |

## Risks

- **Account takeover through linking** (high). Mitigation: rule 3 is enforced
  in one function with a test for every branch above, and settings-linking
  requires an existing session.
- **An open redirect through the callback** (medium). Mitigation: redirects go
  only to fixed `WEB_URL` paths, never to a parameter.
- **CSRF on the OAuth start** (low). Mitigation: `state`, PKCE, and the
  `df_oauth` cookie bound to the browser.

## Open questions

- None.
