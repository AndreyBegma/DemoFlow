# Delete my account

Issue: [#177](https://github.com/AndreyBegma/DemoFlow/issues/177)
Depends on: nothing

## Summary

Roadmap, Phase 5: account deletion removes all metadata and revokes every
Runner token. Data export is a later phase, because the videos are already on
the user's machine.

The owner decided on 2026-10-22: the user types their email to confirm, and
the account is deleted immediately.

## Scope

### In scope

- `apps/api`: `DELETE /me` (authenticated by the web session), the deletion
  itself, and closing any live Runner connections.
- `apps/web`: a "Delete account" section in `/app/settings`.
- `apps/web/src/i18n/en.ts`: the new strings, in their own block.

### Out of scope

- Data export.
- A grace period or undo.
- Admin-side deletion.

## Decisions

1. **Confirmation.** The body is `{ email: string }`. It must equal the
   account's email after trimming, compared case-insensitively. Otherwise the
   API returns `400 confirmation-mismatch` and deletes nothing.
   - This works the same for password accounts and GitHub-only accounts.
   - There is no password re-entry.
2. **What is deleted, in one transaction:**
   - the `User` row;
   - through the existing `onDelete: Cascade`: `GithubIdentity`, `Session`,
     `EmailToken`, `Runner`, and anything later slices hang off `User` with
     cascade (#178's projects and runs must cascade too);
   - `DeviceCode` rows the user approved (`approvedById`). Delete them; they
     are short-lived.
3. **Runners.** After the transaction commits, every live socket of the
   user's Runners gets `{ type: 'bye', reason: 'revoked' }` and is closed. A
   Runner that reconnects with its token gets the same answer as a revoked
   token today.
4. **Session.** The response clears the session cookie. The web app then goes
   to `/` and shows a one-line notice: "Your account was deleted."
5. **UI.** A danger-zone card at the bottom of settings. The button opens a
   dialog with an email field. The confirm button stays disabled until the
   typed email matches.
   - Use Glass UI primitives.
   - The dialog says what is deleted, and that videos on your machines are not
     touched.
6. **Rate and audit.** Keep the existing auth rate limiting. Log one
   structured line, `account.deleted`, with the user id and no email.

## Acceptance criteria

- API integration tests:
  - a wrong email deletes nothing;
  - a matching email (in any case) deletes the user and every cascaded row;
  - a live Runner socket receives `bye revoked` and is closed;
  - the old session cookie is rejected afterwards;
  - the deleted Runner's token is rejected on reconnect;
  - approved device codes are gone.
- Web: the settings section renders, the confirm button stays disabled until
  the email matches, and after deletion the user lands on `/` with the
  notice. Cover it with the app's existing test style.
- No schema migration, unless one is needed for `DeviceCode`. If one is
  needed, name it `<timestamp>_account_deletion`.
- `bun run check`, `bun run test` and `bun run build` are green.

## Open questions

None.
