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

| Command | What it does |
|---|---|
| `demoflow validate <scenario>` | check a scenario against the schema |
| `demoflow run <scenario>` | run it in a browser and render the video |
| `demoflow setup` | install Chromium now instead of on the first run |
| `demoflow mcp` | serve demo generation to MCP clients over stdio |

## With Claude Code

```sh
claude mcp add demoflow -- npx demoflow mcp
```

The server offers `generate_demo`, `get_task`, `cancel_task`,
`validate_scenario`, `list_demos` and `check_project`.

## Licence

MIT. The bundled Inter font files are under the SIL Open Font License 1.1 —
see `fonts/OFL.txt`.
