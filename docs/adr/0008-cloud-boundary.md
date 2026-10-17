# ADR-0008: The cloud boundary

Status: accepted · Date: 2026-10-17

## Context

The runner acts on the user's machine; a compromised website account must not
become arbitrary execution there, and the website must not collect the user's
application data (vision §7, §11, §17).

## Decision

1. **The CLI and the MCP server work without an account.** `demoflow run` and
   `demoflow mcp` are fully local. Cloud sync starts only after
   `demoflow login`. The MCP client is the local OS user; it may run inline
   scenarios against registered projects.
2. **What a runner sends to the cloud**: the scenario's name and id; its steps
   as action, locator and caption; the status of every stage; durations,
   resolution and file sizes; the error message of a failed step. **Never**:
   `fill` values, query strings of URLs, logs, screenshots, traces, video, or
   local file paths.
3. **What the website may make a runner do**: start a run of a scenario that
   exists as a file in a registered project (`demoflow/**/*.demo.json`, by
   id), cancel a run, stream a video (ADR-0009), delete a run's artifacts.
   Nothing else. The website never sends a scenario body, a command or a URL
   to execute.
4. **Commands come only from the local config.** Starting the application
   uses `devCommand` and `readyUrl` from the project's `demoflow.config.json`
   on disk. A `baseUrl` or `navigate` target outside the project's allowed
   origins is refused before the browser starts.
5. **Nothing is uploaded automatically.** Cloud upload of a video is a later,
   explicit, per-video action.

## Consequences

- "Create a demo from the website" means picking a committed scenario; writing
  a new one happens in the repository (by a person or an agent through MCP).
- The video page on the website is a summary plus a stream, never a copy.
