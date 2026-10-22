# CLI offers to update itself

Issue: [#166](https://github.com/AndreyBegma/DemoFlow/issues/166)
Depends on: nothing

## Summary

A user runs an installed `demoflow`. When npm has a newer version, the CLI asks
whether to install it after the command finishes: yes, no, or never for this
version. The owner decided on 2026-10-22: it asks with Y/n and installs, it
checks on every run, and it asks after the command.

## Scope

### In scope

- `apps/cli/src/update/**` (new): the registry check, install detection, the
  prompt and the "never" store.
- The hook in the CLI's top-level command flow (`apps/cli/src/main.ts`), after
  the command settles.
- README: one paragraph and the opt-out variable.

### Out of scope

- A `demoflow update` command.
- Automatic updates without asking.
- Updating a project-local install (`node_modules/.bin/demoflow`). That case
  prints a hint and never prompts.

## Decisions

1. **When it checks.** On every run, the registry request starts with the
   command, in parallel with it:
   `GET https://registry.npmjs.org/demoflow/latest`, 1.5 s timeout.
   - A request still running when the command ends gets 300 ms more, then it
     is abandoned silently.
   - Any network or parse error is silent.
   - The check never delays the command or changes its output or exit code.
2. **When it stays silent.** It never checks and never prompts when any of
   these holds:
   - stdin or stdout is not a TTY;
   - `CI` is set;
   - `DEMOFLOW_NO_UPDATE_CHECK=1`;
   - the command is `mcp` or the runner daemon (`runner --foreground`), or any
     long-lived/background mode;
   - the CLI runs from an npx/bunx/pnpm dlx cache (detected from the package
     path), because those already fetch the latest.
3. **The comparison.** Plain semver: prompt only when `latest > current`.
   Prereleases are never offered. `current` comes from `packageVersion()`
   (`apps/cli/src/version.ts`).
4. **The prompt**, on stderr after the command's own output:
   `demoflow 0.2.0 is available (you have 0.1.0). Update now? [Y/n/never]`.
   - Enter = yes.
   - `never` stores the version and does not ask again until a newer one
     appears.
5. **Installing.** The manager is detected from where the running package
   lives:
   - npm global prefix → `npm install -g demoflow@<v>`;
   - `~/.bun/install/global` → `bun add -g demoflow@<v>`;
   - pnpm global → `pnpm add -g demoflow@<v>`;
   - yarn global → `yarn global add demoflow@<v>`.

   It runs the command with inherited stdio, then prints "Updated to <v>". When
   the manager is unknown or the install is project-local, it prints the
   command instead of running it. When the install fails, it prints the error
   and the npm-permissions hint. The process exit code stays the command's own.
6. **Store.** `update.json` beside the global `config.json`
   (`apps/cli/src/config/home.ts` resolves the directory). It holds
   `{ "skipVersion": "<v>" }`. If it cannot be written, the prompt still works.
7. **Testability.** The fetch, TTY checks, env, prompt input and the spawn of
   the install are injected, so tests never touch the network or install
   anything.

## Acceptance criteria

- Unit tests (Vitest, Node) cover:
  - newer version: prompt; yes runs the detected manager's command;
  - same or older version, and prerelease: no prompt;
  - each silent condition in Decision 2: no request is made at all;
  - a timeout or error: no output, exit code unchanged;
  - `never`: no prompt for that version, a prompt for the next one;
  - unknown manager or local install: the command is printed, not run;
  - a failed install: the exit code is still the command's own.
- The prompt goes to stderr. stdout of `demoflow run --json` and the like is
  unchanged.
- `bun run check`, `bun run test` and `bun run build` are green, and so is the
  execution-plane matrix (all three OSes).

## Risks

- `npm install -g` may need sudo on some Linux setups. Print the failure hint;
  never retry with sudo.
- Windows: an installed `demoflow.cmd` replacing itself while running. The
  install runs after the command is done, and the message says to re-run.

## Open questions

None.
