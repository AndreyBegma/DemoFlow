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
`render/ffmpeg.vertical.mp4`.

`mp4-vertical` is a 1080×1920 MP4 for phones, rendered from the same run. The
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

`demoflow record` writes a scenario from what you do in the app. To post the
same thing for several items, tick a run of steps in the recording panel and
choose **Repeat over data**. Name the list, then give one line per item for each
typed value (the first line is what you recorded). The panel writes the `data`
block and wraps the steps in a `repeat` with `{{item.text}}` in place of each
typed value. Secret fills are left as recorded.

| Command | What it does |
|---|---|
| `demoflow record [name]` | record a scenario by using the app |
| `demoflow validate <scenario>` | check a scenario against the schema |
| `demoflow run <scenario>` | run it in a browser and render the video |
| `demoflow setup` | install Chromium now instead of on the first run |
| `demoflow mcp` | serve demo generation to MCP clients over stdio |
| `demoflow login` | pair this machine with your DemoFlow account |
| `demoflow logout` | revoke this machine and delete its credentials |
| `demoflow runner start` | keep this machine connected, in the background |
| `demoflow runner stop` / `status` / `logs` | stop it, check it, read its log |
| `demoflow runner install` / `uninstall` | start the runner at every login, or stop doing so |

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
- The server is `https://demoflow-app.luna-realm.com` (staging) unless
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
  (`connected`, `reconnecting in Ns`, `revoked`), the server and whether
  autostart is installed. `--json` prints the same as one object.
- `runner logs` prints `runner.log`; `--follow` keeps printing.
- `runner stop` stops it; `logout` stops it first.
- One runner per machine. A second `start` prints the running PID.
- It reconnects with backoff (1 s doubling to 60 s) when the connection drops,
  and exits for good when the machine is revoked on the website.
- Every 30 days the server rotates the token over the connection; the runner
  rewrites `credentials.json`.
- `runner.log` (rotated at 5 MB, three files kept), `runner.lock` and
  `runner.state.json` sit next to `credentials.json`. None holds the token.

### Start at login

```sh
npx demoflow runner install
```

Registers the runner for your user, with no admin rights, and starts it now.
It needs `demoflow login` first. The unit runs the same `node` and CLI that
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

## With Claude Code

```sh
claude mcp add demoflow -- npx demoflow mcp
```

The server offers `generate_demo`, `get_task`, `cancel_task`,
`validate_scenario`, `list_demos` and `check_project`.

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
