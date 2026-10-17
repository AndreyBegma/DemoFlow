# ADR-0006: Multi-user accounts — GitHub OAuth and email/password

Status: accepted · Date: 2026-10-17

## Context

DemoFlow is a multi-user SaaS from its first version. Workspaces (shared
ownership) come later. The audience is developers.

## Decision

1. **Every row that belongs to someone is owned by a user**, and every read
   path checks ownership. Every specification that adds a read path carries an
   authorization test: another user's data is not returned through it.
2. **Two ways to sign in from the start: GitHub OAuth and email/password.**
   Passwords are hashed with argon2id. Email/password requires email
   verification; password reset is by an emailed, single-use, expiring link.
3. **Linking.** Signing in with GitHub links to an existing account with the
   same email only when both the GitHub email and the account email are
   verified. Otherwise the sign-in is refused with a hint to sign in with the
   password and link GitHub from settings.
4. **Email is sent through Resend.** Locally and in CI the mailer is replaced
   by a test double that records messages.
5. **Sessions** are httpOnly, secure, same-site cookies issued by the API.
   Runner credentials are separate (ADR-0007).

## Consequences

- Account takeover through an unverified email is closed by rule 3.
- Two sign-in paths means two sets of tests and an account-linking screen.
- A Resend account, a verified sending domain and an API key are needed
  before email/password reaches staging.
