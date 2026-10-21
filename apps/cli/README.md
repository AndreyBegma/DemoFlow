# demoflow

Turn a scenario into a demo video. A scenario is a JSON file of steps —
navigate, click, fill, assert — that a real browser runs against your app while
it records; FFmpeg then renders the recording with captions and an end card.

## Requirements

Node.js 20 or newer, on Linux, macOS or Windows. Chromium is downloaded on
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
`render/ffmpeg.mp4`, `render/ffmpeg.gif` and `render/ffmpeg.webm`.

| Command | What it does |
|---|---|
| `demoflow validate <scenario>` | check a scenario against the schema |
| `demoflow run <scenario>` | run it in a browser and render the video |
| `demoflow setup` | install Chromium now instead of on the first run |
| `demoflow mcp` | serve demo generation to MCP clients over stdio |
| `demoflow login` | pair this machine with your DemoFlow account |
| `demoflow logout` | revoke this machine and delete its credentials |

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

## With Claude Code

```sh
claude mcp add demoflow -- npx demoflow mcp
```

The server offers `generate_demo`, `get_task`, `cancel_task`,
`validate_scenario`, `list_demos` and `check_project`.

## Licence

MIT. The bundled Inter font files are under the SIL Open Font License 1.1 —
see `fonts/OFL.txt`.
