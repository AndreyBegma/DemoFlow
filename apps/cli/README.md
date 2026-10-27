# demoflow

Turn a scenario into a demo video. A scenario is a JSON file of steps —
navigate, click, fill, assert — that a real browser runs against your app while
it records; FFmpeg then renders the recording with captions and an end card.

## Requirements

Node.js 22 or newer, on Linux, macOS or Windows. Chromium is downloaded on
first use (about 250 MB, once); `demoflow setup` downloads it ahead of time.
On Linux, Chromium also needs its system libraries:
`npx playwright install-deps chromium`.

## Use

```sh
npx demoflow validate demoflow/login.demo.json
npx demoflow run demoflow/login.demo.json
```

A project has a `demoflow.config.json` at its root:

```json
{ "baseUrl": "http://localhost:3000" }
```

`demoflow run` prints where the video landed; `--json` prints the run result
as one JSON object instead.

A run renders an MP4 by default. `render.formats` asks for GIF and WebM (VP9)
as well, all encoded in one pass; the GIF is 800 px wide at 12 fps unless
`render.gif` says otherwise:

```json
{
  "baseUrl": "http://localhost:3000",
  "render": {
    "formats": ["mp4", "gif"],
    "gif": { "width": 800, "fps": 12 }
  }
}
```

`demoflow run --format gif --format mp4` replaces `render.formats` for one
run; `generate_demo` takes the same list as `formats`. The files are
`render/ffmpeg.mp4`, `render/ffmpeg.gif`, `render/ffmpeg.webm` and
`render/ffmpeg.vertical.mp4`, `render/ffmpeg.vertical.webm`,
`render/ffmpeg.vertical.gif`, `render/ffmpeg.square.mp4`,
`render/ffmpeg.square.webm` and `render/ffmpeg.square.gif`.

`mp4-vertical` is a 1080×1920 MP4 for phones, rendered from the same run.
`webm-vertical` is the same frames as a 1080×1920 VP9 WebM, and `gif-vertical`
as a GIF whose height is `render.gif.width` (450×800 by default, the pixels of
the landscape GIF). They share the crop below; ask for any mix of them. The
page is still recorded at its normal size. A 9:16 crop follows each step's
target and stays on the page. Each step's `zoom` still applies inside it, and
captions sit larger in a band at the bottom. `render.vertical` tunes it, all
optional:

```json
{
  "render": {
    "formats": ["mp4", "mp4-vertical"],
    "vertical": { "followMs": 400, "deadZone": 0.1, "captionBand": 0.22 }
  }
}
```

`followMs` is how long the crop takes to move to the next target. A move
shorter than `deadZone` (a share of the crop width) is skipped, so the camera
does not jitter. `captionBand` is the share of the frame height, at the
bottom, that captions sit in.

`mp4-square`, `webm-square` and `gif-square` are the same for a 1:1 crop, the
size of feed posts: a 1080×1080 MP4, a 1080×1080 VP9 WebM, and a GIF whose side
is three quarters of `render.gif.width` (600×600 by default, again the pixels of
the landscape GIF). The square crop has its own camera, so `render.square`
takes the same three fields as `render.vertical` and tunes it alone; captions
are cut to two lines. Ask for any mix of landscape, vertical and square files
in one run:

```json
{
  "render": {
    "formats": ["mp4", "mp4-vertical", "mp4-square", "gif-square"],
    "square": { "followMs": 400, "deadZone": 0.1, "captionBand": 0.22 }
  }
}
```

### Parallel runs: `${PORT}`, `--port` and `--fresh-app`

`baseUrl`, `devCommand.command`, each `devCommand.args` entry and
`devCommand.readyUrl` may hold `${PORT}`; the three `devCommand` fields may
also hold `${BASE_URL}`. DemoFlow fills them itself, on every OS, before the
app starts:

```json
{
  "baseUrl": "http://127.0.0.1:${PORT:-3000}",
  "devCommand": {
    "command": "npx",
    "args": ["vite", "--port", "${PORT}", "--strictPort"],
    "readyUrl": "${BASE_URL}/"
  }
}
```

`${PORT}` is `--port <n>`, else `PORT` from the environment, else the default
in `${PORT:-3000}`. `${BASE_URL}` is `--base-url`, else `baseUrl` once
filled; it is never read from the environment. `$${` is a literal `${`. Any
other name, such as `${HOME}`, is a config error (exit 2), and so is a
`${PORT}` with no port from any source in `run` and `record`; `check`, `list`,
`runs` and `render` load such a config without a port. `allowedOrigins`
always includes the origin of the base URL the run uses.

`demoflow run --port <n>` also sets `PORT` for the app. Two checkouts of the
same app can then run at once, each with its own port:

```sh
demoflow run demoflow/tour.demo.json --json --port 4101 --fresh-app
demoflow run demoflow/tour.demo.json --json --port 4102 --fresh-app
```

Without `--fresh-app`, an app that already answers on `readyUrl` is used as
is. With it, the run refuses instead — exit 2, nothing on stdout, no run
directory, stderr `app-already-running: --fresh-app: <readyUrl> already
answers; …` — so a caller can retry on another port. Prefer a dev command
that fails when its port is taken (`vite --strictPort`): an app that takes the
port between the check and the start is then caught too. The command still
runs without a shell, so `%PORT%` and `$PORT` stay literal text.

`demoflow render <runId>` renders a finished run again from
`<home>/runs/<runId>/` with the current `render.*` config, without the app or
the browser — to restyle it, add a format, or retry a render that crashed.
It takes `--format`, `--out` and `--json` like `run`. Only `renders[]` and the
`rendering` stage of `result.json` change: a failed run stays failed and
keeps its failure card. Files of formats it does not write stay on disk but
are no longer listed. The website is not told, so its runs list keeps the
first render's formats. A run that is unfinished or has no recording is
refused with exit 2; a render that fails exits 3.

`demoflow run --check <scenario>` runs and verifies the scenario against the
live app like `run`, but records and renders nothing: the run directory holds
only `result.json`, with `recording` and `rendering` skipped. Without a
scenario, `demoflow run --check` runs every valid scenario of the project
(the files under `demoflow/`, sorted, at most 100) one after another against a
single start of `devCommand`, and prints one line per scenario, then
`N passed, M failed`. `--exclude <id>` leaves a scenario out of such a pass
(repeatable; `demoflow/login.demo.json` or `login.demo.json`; an id that is no
scenario is ignored). `--json` prints `{ "check": true, "passed", "failed",
"runs": [...] }`, each run as `run --json` prints it. It exits 0 when every run
passed and 1 when any failed. `--format` and `--headed` are refused with exit 2
before anything runs. Each run is reported like any other, marked as a check.
Unlike `demoflow check`, which only inspects files and tools, this opens the
app.

### Scheduled checks

`schedule` makes the runner (`demoflow runner start`) run `demoflow run --check`
over the whole project on its own, at a set time:

```json
{
  "baseUrl": "http://localhost:3000",
  "schedule": {
    "cadence": "weekly",
    "weekday": "mon",
    "at": "09:30",
    "exclude": ["demoflow/wip.demo.json"]
  }
}
```

- `cadence` is `daily`, `weekdays` (Monday to Friday) or `weekly`; `weekly`
  needs `weekday` (`mon` … `sun`), the others refuse it.
- `at` is `HH:MM`, 24-hour, in the time zone of the machine the runner runs on.
  A time the clock skips when daylight saving starts runs at the next valid
  minute; a time that repeats when it ends runs once, the first time.
- `exclude` lists scenario ids the pass leaves out (at most 100), as
  `--exclude` does.
- The runner watches the projects it has reported runs for and the projects
  `demoflow run` ran in on this machine. It reads each `schedule` every
  minute, so an edit needs no restart. A project with a config that does not
  load is skipped and named in `runner.log`.
- One pass at a time, and never next to a run started from the website: a
  pass that comes due waits for it. A pass is stopped after 2 hours, or after
  15 minutes on one scenario.
- A machine that was off or asleep at the time runs one pass when the runner
  next looks, however many it missed. A new schedule waits for its first time:
  it does not run at once.
- The passes are reported like any other check run (off without
  `demoflow login`, under `CI`, or with `DEMOFLOW_NO_REPORT=1`).

Without `demoflow login`, `runner start` and `runner install` still work when a
watched project has a schedule. The runner then runs in local mode: no
connection, scheduled checks only. `runner status` shows each scheduled
project, its next check (while the runner runs) and the last one, with its
result. A schedule runs only while the runner does: use
[`demoflow runner install`](#start-at-login) so it starts at every login.

`demoflow init [--base-url <url>]` writes `demoflow.config.json` (default
`baseUrl` `http://localhost:3000`) and `demoflow/first.demo.json`, a scenario
that opens `/` and passes against any app at `baseUrl`, in the current folder.
An existing file is never overwritten: it is reported as `kept`. An invalid
`--base-url` exits 2 and writes nothing.

`demoflow list` prints the recent runs of the current project, newest first:
status, start time, duration, scenario name and run id, plus the run's page URL
when it was reported to the website. `--limit <n>` takes 1–100 (default 20);
anything else exits 2. `--json` prints the MCP's `list_demos` answer, one
`{ "demos": [...] }` object.

`demoflow check` prints the project root, whether the config is valid, the
scenario files (listed, not validated — `demoflow validate` does that), FFmpeg
(`system`, `bundled` or `missing`) and the browser (`installed` or `missing`,
with a `demoflow setup` hint). It exits 0 when FFmpeg and the browser are
available and 1 when either is missing, so CI can gate on it. `--json` prints
the MCP's `check_project` answer.

Both commands are read-only: no browser, no file written, no network request.
Outside a project (no `demoflow.config.json` in the folder or above) they exit 2.

Runs pile up in `<home>/runs/`. `demoflow runs list` prints every run there,
newest first: status (`partial` for a run that never finished, `active` for one
touched in the last 5 minutes), date, size, scenario name and run id, then the
total. `demoflow runs delete <id…>` deletes runs by id, and
`demoflow runs prune --older-than 30d` or `--partial-only` deletes the runs
matching every filter given. Nothing asks for confirmation, so preview with
`--dry-run` first. An active run is never deleted, and nothing outside
`<home>/runs/` is ever touched. These commands work outside a project too, and
take `--out <dir>` like `run`.

`demoflow record` writes a scenario from what you do in the app. To post the
same thing for several items, tick a run of steps in the recording panel and
choose **Repeat over data**. Name the list, then give one line per item for each
typed value (the first line is what you recorded). The panel writes the `data`
block and wraps the steps in a `repeat` with `{{item.text}}` in place of each
typed value. Secret fills are left as recorded.

| Command | What it does |
|---|---|
| `demoflow init` | write `demoflow.config.json` and a first scenario here |
| `demoflow record [name]` | record a scenario by using the app |
| `demoflow validate <scenario>` | check a scenario against the schema |
| `demoflow run <scenario>` | run it in a browser and render the video |
| `demoflow run --check [scenario]` | run and verify one scenario, or all of them, without a video |
| `demoflow render <runId>` | render an existing run again with the current config |
| `demoflow share <runId>` | share a render of a reported run as a link on the website |
| `demoflow list` | list recent runs of the current project, newest first |
| `demoflow runs list` | list every run on this machine, with its size |
| `demoflow runs delete <id…>` / `prune` | delete runs by id, or by age and state |
| `demoflow check` | check that the project, FFmpeg and the browser are ready |
| `demoflow setup` | install Chromium now instead of on the first run |
| `demoflow mcp` | serve demo generation to MCP clients over stdio |
| `demoflow login` | pair this machine with your DemoFlow account |
| `demoflow logout` | revoke this machine and delete its credentials |
| `demoflow runner start` | keep this machine connected, in the background |
| `demoflow runner stop` / `status` / `logs` | stop it, check it, read its log |
| `demoflow runner install` / `uninstall` | start the runner at every login, or stop doing so |
| `demoflow runner allow <dir>` / `disallow <dir>` / `roots` | choose the folders the website may name |

## Pair this machine with your account

```sh
npx demoflow login
```

The command prints a code such as `ABCD-1234` and opens
`<server>/app/device?code=ABCD-1234`. Check that the code matches your
terminal, then approve it while signed in with a verified email. Over SSH with
no browser, open `<server>/app/device` yourself and type the code. The code
expires after 10 minutes.

- Already paired: `login` prints the account and machine name. `--force` pairs
  again and revokes the old token first.
- `demoflow logout` revokes the token on the server, then deletes the file. If
  the server cannot be reached it still deletes the file; the machine stays
  listed under `/app/machines` until you revoke it there.
- The server is `https://demoflow.luna-realm.com` (production) unless
  `--server <url>` or `DEMOFLOW_SERVER` says otherwise. It is the website's
  origin; the API is under `/api`. `logout` uses the server stored at login.
- The token is in `credentials.json` (`{ server, token, runnerId }`, mode 0600)
  next to the global `config.json`: `$XDG_CONFIG_HOME/demoflow/` or
  `~/.config/demoflow/`, `~/Library/Application Support/demoflow/`, or
  `%APPDATA%\demoflow\`. It is never printed or logged.
- The cloud learns the machine's name, OS and release, CLI version and when the
  token was last used. Nothing else.

## Keep the machine connected

```sh
npx demoflow runner start
```

The runner is a background process that holds one connection to the server,
so `/app/machines` shows the machine online, with when and from which address
it was last seen. After `login` the CLI asks whether to start it
(`--start` / `--no-start` answer in advance; with no terminal it only prints
the command). No jobs run over it yet.

- `runner status` prints whether it runs (PID, uptime), the connection
  (`connected`, `reconnecting in Ns`, `revoked`, or local mode), the server,
  whether autostart is installed, and the next and last check of each
  scheduled project. `--json` prints the same as one object.
- `runner logs` prints `runner.log`; `--follow` keeps printing.
- `runner stop` stops it; `logout` stops it first.
- One runner per machine. A second `start` prints the running PID.
- It reconnects with backoff (1 s doubling to 60 s) when the connection drops,
  and exits for good when the machine is revoked on the website.
- Every 30 days the server rotates the token over the connection; the runner
  rewrites `credentials.json`.
- `runner.log` (rotated at 5 MB, three files kept), `runner.lock`,
  `runner.state.json`, `schedule.state.json` (each scheduled project's last
  pass) and `local-roots.jsonl` (the projects `demoflow run` ran in, the last
  500) sit next to `credentials.json`. None holds the token.

### Start at login

```sh
npx demoflow runner install
```

Registers the runner for your user, with no admin rights, and starts it now.
It needs `demoflow login` first, unless a watched project has a `schedule`
(local mode, see [Scheduled checks](#scheduled-checks)). The unit runs the same `node` and CLI that
ran `install`, by absolute path; if you move or upgrade the CLI, run
`install` again. `runner uninstall` removes it; a running runner keeps
running until `runner stop`.

| OS | What it creates |
|---|---|
| Linux | a systemd user unit, `~/.config/systemd/user/demoflow-runner.service`, enabled with `systemctl --user` |
| macOS | a LaunchAgent, `~/Library/LaunchAgents/dev.demoflow.runner.plist` |
| Windows | a Task Scheduler task, `DemoFlowRunner`, at logon for the current user |

A crash is restarted (systemd, launchd). A runner stopped on purpose, or
revoked on the website, exits cleanly and stays down. Windows does not
restart a crash; the next logon starts it again. Neither file holds the token.

### Folders the website may name

From the website you can add a project by naming a folder on this machine.
The runner then reads that folder (whether it has `demoflow.config.json`,
its scenarios' ids and names, the GitHub `origin` of `.git/config`), can
create the `demoflow init` files in it, and can register it so the website
may start runs there. It never sends a file's contents or a config value.

A folder qualifies only inside an allowed root. By default the only root is
your home directory.

```sh
npx demoflow runner allow ~/code      # the first allow replaces the home directory
npx demoflow runner disallow ~/code   # removing the last root allows nothing
npx demoflow runner roots             # the roots in force; --json for a script
```

- The roots are in `allowed-roots.json` (`{ "roots": [...] }`, at most 32,
  mode 0600) next to `credentials.json`. A file that does not parse refuses
  every folder until you fix or delete it; `roots` says so.
- The folder must exist, be a directory, and be reached without a link that
  leads out of its root. No folder below the root may start with `.`, so
  `~/.ssh` or `~/.config` are never offered.
- On Windows a drive path is required (`C:\…`); network (`\\server\…`) and
  device (`\\?\…`) paths are refused. Windows and macOS compare paths without
  case.
- The folders registered from the website are kept in
  `website-projects.jsonl` next to `credentials.json` (the last 1,000). A
  folder whose root you disallow stops being runnable from the website.

## Runs on the website

On a paired machine, `demoflow run` tells the website that the run happened, so
it appears in your project's library. Only metadata is sent:

- the project folder and its name, the scenario's name and path, the verdict,
  the start time, the duration and the CLI version;
- each stage's status (not its details);
- for each rendered file, its format, resolution, size and render time;
- for a failed run, the failed step's number, the failing stage and its error
  message.

The error message is redacted on your machine first: query strings and
fragments of URLs are removed, the project path becomes `<project>`, the home
directory becomes `~`, and the text is cut to 1,000 characters. It can still
contain text from the page under test or other paths.

Videos, frames and step values never leave the machine, unless you share a
render (below).

The report waits at most two seconds and fails silently; the run's output and
exit code are never affected. It is off without `demoflow login`, under `CI`,
and with `DEMOFLOW_NO_REPORT=1`.

## Share a render

```sh
npx demoflow share <runId>
```

Makes a link to one render of a run that this machine reported, so anyone with
the link can watch it without an account. The runner uploads the file, so it
must be running (`demoflow runner start`). The command prints the share page's
link and, without a password, the file's own link, then exits 0 once the
upload is done.

- `--format <format>` picks the render (default: the run's first one).
- `--expires <days>`: 7, 30 (default) or 90 days.
- `--password` asks for a password twice on the terminal, without echo;
  without a terminal it reads `DEMOFLOW_SHARE_PASSWORD`. It is never a flag
  value, so it never lands in your shell history. A protected share has no file
  link (it would skip the password), so only the page link is printed.
- `--json` prints the share as one object on stdout.
- A render already shared keeps its link; the command prints it. Revoke it on
  the website to share the render again.
- Only that render leaves the machine, with its poster frame, the chapters
  (the scene cards) and the scenario's `description`.
- It exits 2 when the share cannot be made (not logged in, a run this
  machine did not report, no such render, the runner offline or too old, the
  file over the size limit, the quota full), 1 when the upload fails or is
  still going after 10 minutes, and 3 when the server cannot be reached.

## With Claude Code

```sh
claude mcp add demoflow -- npx demoflow mcp
```

The server offers `generate_demo`, `get_task`, `cancel_task`,
`validate_scenario`, `list_demos`, `check_project` and `share_demo`.

`share_demo` shares a render of a reported run, like `demoflow share` without
a password. It is refused (`share-not-allowed`) unless the run's project allows
it in `demoflow.config.json`, which you commit:

```json
{ "share": { "allowMcp": true } }
```

It waits up to 50 seconds for the upload; when the answer is still
`uploading`, call it again later for the same link.

## Updates

A globally installed `demoflow` asks npm for the latest version while a
command runs, and after the command finishes asks
`Update now? [Y/n/never]` on stderr. Yes installs it with the manager that
installed it (`npm install -g`, `bun add -g`, `pnpm add -g` or
`yarn global add`); `never` skips that version until a newer one appears. A
project install, or one whose manager it cannot tell, prints the command
instead. The check gives up after 1.5 s, never changes a command's output or
exit code, and stays silent without a terminal, under `CI`, for `mcp` and the
runner, and under npx / bunx / pnpm dlx. `DEMOFLOW_NO_UPDATE_CHECK=1` turns it
off.

## Licence

MIT. The bundled Inter font files are under the SIL Open Font License 1.1 —
see `fonts/OFL.txt`.
