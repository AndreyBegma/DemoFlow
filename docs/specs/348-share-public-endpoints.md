# Public share endpoints: page data, file, poster, password, views, expiry

Issue: [#348](https://github.com/AndreyBegma/DemoFlow/issues/348)
Depends on: #347. Implements [ADR-0019](../adr/0019-opt-in-share-links.md) §5.

## Summary

#347 stores a share; nobody can open it yet. This slice adds what a viewer
without an account reaches: the share page's data (`GET /s/:token`), the
file and the poster (`/s/:token/file`, `/s/:token/poster`) with byte ranges,
the password unlock with a rate limit, the view counter, and expiry enforced
on every request. The page that renders it is #351.

## Scope

### In scope

- `apps/api/src/shares/public-shares.controller.ts` (new, no session guard),
  `public-shares.service.ts`, `share-access.ts` (the unlock cookie), their
  specs, and their registration in `apps/api/src/shares/shares.module.ts`.
- `apps/api/src/auth/auth-throttle.ts`: the `share-unlock` throttler.
- `apps/api/.env.example`, `deploy/staging/.env.example`,
  `deploy/staging/docker-compose.yml`, `deploy/staging/refresh.sh`:
  `SHARE_SIGNING_SECRET`.
- `deploy/staging/Caddyfile`: route `/s/<token>/file` and `/s/<token>/poster`
  to the API.
- `apps/web/next.config.ts`: the same two paths rewritten to the API locally.
- `deploy/README.md`: the route and the secret.

### Out of scope

- The page `/s/[token]` itself and its password form (#351).
- Owner endpoints and storage (#347).
- `deploy/production/` (#289; the second to merge mirrors the Caddy route and
  the secret, as #347 says for the volume).
- Embedding through an iframe (the owner chose page + direct file, Q6).

## Decisions

1. **URLs.** [Source: owner, Q6] The share page is `${WEB_URL}/s/<token>` (a
   Next page, #351). Its data is `GET /api/s/:token` — the API route
   `GET /s/:token` behind Caddy's `/api` prefix strip [Confirmed:
   `deploy/staging/Caddyfile`]. The file and the poster live **on the page's
   own path**, so a link reads well in a README: `${WEB_URL}/s/<token>/file`
   and `${WEB_URL}/s/<token>/poster`. Caddy sends exactly those two paths to
   the API unchanged (`path_regexp ^/s/[A-Za-z0-9_-]{43}/(file|poster)$`,
   before the `web` handler); `next.config.ts` adds the same rewrite for
   local development. The API routes are therefore `GET /s/:token`,
   `GET|HEAD /s/:token/file`, `GET|HEAD /s/:token/poster`,
   `POST /s/:token/unlock`.
2. **What a share answers.**

   | Share state | `GET /s/:token` | file / poster |
   |---|---|---|
   | unknown token, `uploading`, `failed` | `404 not-found` | `404` |
   | `ready`, expired (`expiresAt ≤ now`, not yet swept) | `410 expired` | `410` |
   | `lost`, or `ready` but the file is missing (marks it `lost`) | `410 unavailable` | `410` |
   | `ready`, password set, no valid unlock cookie | `200 { locked: true }` | `403 locked` |
   | `ready`, no password, or a valid cookie | `200 ShareData` | `200` / `206` |

   A locked answer carries nothing about the video — not the title, not the
   size. Expiry is checked on every request; the sweeper (#347) only cleans up.
3. **`ShareData`:** `{ title, description, chapters, format, kind:
   'video' | 'image', width, height, durationMs, sizeBytes, expiresAt,
   fileUrl, posterUrl, downloadUrl }`. `kind` is `image` for the three GIF
   formats. `fileUrl` and `posterUrl` are the Decision 1 paths;
   `downloadUrl` is `fileUrl + '?download=1'`.
4. **The file.** Byte ranges through `apps/api/src/videos/byte-range.ts`
   [Confirmed], `Content-Type` from `VIDEO_CONTENT_TYPES`
   (`video-relay.service.ts` [Confirmed]), `Content-Disposition: inline`,
   or `attachment` with `download-name.ts`'s name for `?download=1`
   [Confirmed]. Without a password: `Cache-Control: public, max-age=300` and
   `Cross-Origin-Resource-Policy: cross-origin`, so the file embeds in
   another site (helmet's default is `same-origin`). With a password:
   `Cache-Control: private, no-store`, CORP left at `same-origin`.
   [Source: ADR-0019 §5, "the direct file URL works only for shares without a
   password"]
5. **Unlock.** `POST /s/:token/unlock { password }` (8–128 characters) checks
   with `PasswordHasher.verify` [Confirmed]. Right: `204` and a cookie
   `df_share_<share.id>`, `HttpOnly`, `Secure` (except in development),
   `SameSite=Lax`, `Path=/`, `Max-Age` 12 hours, whose value is
   `<exp>.<hmac>` with `hmac = HMAC-SHA256(SHARE_SIGNING_SECRET, share.id +
   exp + passwordHash)`. Including the hash means a later password change
   would void old cookies. Wrong: `401 wrong-password`. The global origin
   check covers this POST [Confirmed: `security/origin-check.ts`].
6. **Rate limit.** A `share-unlock` throttler in `auth-throttle.ts`,
   following its pattern [Confirmed]: 10 attempts per 10 minutes per IP and
   token, off by default and switched on only for the unlock route. Over the
   limit: `429`.
7. **Views.** [Source: owner, Q10] `GET /s/:token` adds 1 to `views` with an
   atomic `update … increment` each time it returns `ShareData`. File, poster
   and locked answers do not count. Nothing about the viewer is stored or
   logged — no IP, no user agent, no referrer. Page loads by link unfurlers
   count; that is accepted.
8. **`SHARE_SIGNING_SECRET`.** At least 32 characters. Production
   (`APP_ENV=production`) refuses to start without it and names the variable,
   as the mail check does [Confirmed: `apps/api/.env.example`]. Development
   without it uses a random value per boot (unlock cookies end at restart).
   Staging generates it: `deploy/staging/.env.example` gains an empty
   `SHARE_SIGNING_SECRET=`, `refresh.sh` fills it like `POSTGRES_PASSWORD`
   [Confirmed: `fill_if_empty`], and `docker-compose.yml` passes it to `api`.

## Acceptance criteria

- [ ] `GET /s/:token` answers each row of the Decision 2 table, checked with a
      row per state in an integration spec.
- [ ] A locked answer's JSON has exactly one key, `locked`.
- [ ] `GET /s/:token/file` with `Range: bytes=0-99` answers `206` with 100
      bytes and `Content-Range`; `?download=1` answers `attachment`; a GIF
      share answers `image/gif`.
- [ ] Without a password the file carries `Cross-Origin-Resource-Policy:
      cross-origin` and `Cache-Control: public, max-age=300`; with a password
      and no cookie it answers `403 locked`, and with the cookie from a right
      unlock it answers `200`.
- [ ] Wrong passwords answer `401`; the 11th attempt within 10 minutes from
      one IP for one token answers `429`; a cookie signed for share A does not
      open share B.
- [ ] `views` grows by one per unlocked `GET /s/:token` and not on file,
      poster or locked requests; no log line holds an IP or a token.
- [ ] A share whose `expiresAt` passed answers `410 expired` before the
      sweeper ran.
- [ ] **Authorization:** the public endpoints never return a share by id, a
      user id, a run id or a project id; only the token opens a share, and a
      token of one share never reaches another's file.
- [ ] Locally (`bun run start:dev`), `http://localhost:3670/s/<token>/file`
      plays through the Next rewrite; on staging the same path is answered
      by the API through Caddy.
- [ ] The API refuses to start with `APP_ENV=production` and no
      `SHARE_SIGNING_SECRET`.
- [ ] `bun run check`, `bun run build`, `bun run test` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i348-public | the public endpoints | apps/api/src/shares/public-shares.*, apps/api/src/shares/share-access.*, apps/api/src/shares/shares.module.ts, apps/api/src/auth/auth-throttle.ts, apps/api/.env.example, apps/web/next.config.ts, deploy/staging/Caddyfile, deploy/staging/.env.example, deploy/staging/docker-compose.yml, deploy/staging/refresh.sh, deploy/README.md | #347 | yes | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| deploy/staging/** | i348-public after #347 merged | #289 mirrors into deploy/production/ |
| apps/web/next.config.ts | i348-public | do not open it |
| apps/api/src/shares/shares.module.ts | i348-public after #347 | do not open it |

## Risks

- **Caddy regex out of step with the token format** (low). A different token
  length breaks the route. Mitigation: the length comes from
  `generateToken()`; a spec asserts the token matches the Caddy pattern.
- **Unfurlers inflate views** (low). Accepted (Decision 7).

## Open questions

- A password change endpoint — default: none (#347, Open questions); the
  cookie format already supports it.
