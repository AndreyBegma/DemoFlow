# @demoflow/web

Next.js 16 (App Router) front end. See the root `CLAUDE.md` for commands.

## UI strings

Every user-facing string goes through `t()` from `@/i18n`; never write one
inline in a component or in `metadata`.

```tsx
import { t } from '@/i18n';

<h1>{t('home.title')}</h1>;
t('greeting', { name: user.name }); // for "Hello, {name}!"
```

- Strings live in `src/i18n/en.ts`: a nested `as const` object, at most four
  levels deep. Add a string there first, then use its dotted key.
- Keys are typed: a missing or misspelt key fails `tsc` and `next build`.
- `{name}` placeholders require `params.name` at the type level.
- `t()` is a pure function with no provider, so it works in server and client
  components.
- Dates and numbers are formatted with `Intl` at the call site, not in the
  dictionary.

## API access

The browser only ever calls `/api/…` on its own origin. Locally `next.config.ts`
rewrites `/api/:path*` to `API_URL` (default `http://localhost:8370`); on
staging Caddy does the same. `/api` is therefore reserved for the API: do not
add a Next route under it. Server components call `API_URL` directly and forward
the request's cookies (`src/lib/session.ts`).
