# DemoFlow — Product Vision & Architecture

> **Project name:** DemoFlow
> **Document type:** Product concept and architecture overview
> **Status:** Initial specification — architectural decisions should be
> validated during implementation planning.

## 1. Product concept

DemoFlow is a standalone developer tool that turns software features and
AI-generated code changes into polished, verifiable product demonstration
videos.

A developer can work in any supported repository using Claude Code, Cursor,
Codex, AgentDock, or another compatible tool. Once a feature is implemented,
the developer or AI agent asks DemoFlow to create a demonstration. DemoFlow
runs a structured browser scenario using Playwright, verifies the expected
behavior, records the interaction, renders a polished video, and makes the
result available locally and in the DemoFlow website.

DemoFlow is not an AgentDock feature. It is an independent product that can
integrate with AgentDock while remaining useful across unrelated projects and
development environments.

### Core promise

**Implement a feature → run a verified demo → render a polished video → browse
it in DemoFlow → play it with Luna Player.**

The main product value is not simply recording a browser. It is automating the
process of producing a clear, repeatable demonstration of a feature implemented
by a developer or AI agent.

## 2. Product principles

- **Standalone:** DemoFlow must not depend on AgentDock.
- **MCP-first:** AI agents should be able to request and manage demos through
  MCP.
- **CLI-accessible:** Developers and automation scripts should be able to use
  the same capabilities from the terminal.
- **npm-friendly:** Core functionality and optional SDK integration should be
  distributable through npm.
- **Playwright-powered:** Browser scenarios should run through a reliable,
  controlled automation engine.
- **Local-first:** Source recordings and rendered videos stay on the user's
  machine by default.
- **Cloud-connected:** The website manages accounts, Runner connections,
  project metadata, task history, and the video library.
- **Reproducible:** Scenarios should be structured, validated, repeatable, and
  versionable.
- **Verified:** Scenario execution, assertions, rendering, and artifact
  availability must have distinct statuses.
- **Extensible:** New AI clients, rendering styles, storage backends, and
  player integrations should be added through well-defined interfaces.
- **Privacy-conscious:** No automatic upload of source code, recordings, or
  videos without explicit authorization.

## 3. Main product components

DemoFlow should consist of the following logical components. They do not all
need to be separate deployable services in the first version.

### 3.1. DemoFlow Web — the website

The website is the central control panel and library for the product.

It should provide:

- User registration and authentication.
- Workspace and project organization.
- Local Runner registration and connection status.
- Pairing a local machine with the user's account.
- Starting and monitoring demo jobs.
- Demo history and task status.
- A library of generated videos.
- Video details, metadata, and verification results.
- Links to available local artifacts.
- Optional cloud storage and sharing controls.
- Rendering preferences and project settings.
- Luna Player playback integration.
- Error diagnostics and execution history.

The website should be useful even when a video is stored only on a connected
local machine. It must clearly show whether an artifact is local, cloud-hosted,
or temporarily unavailable.

The site should not imply that a local file is publicly accessible simply
because it has a page in DemoFlow.

### 3.2. DemoFlow Runner — local execution agent

The Runner is a local background process installed on the developer's machine.
It performs work that requires access to local projects, local development
servers, the browser, and local files.

Responsibilities:

- Register the machine with the user's DemoFlow account.
- Maintain an authenticated outbound connection to the platform.
- Receive authorized demo jobs.
- Access only explicitly registered project directories.
- Start or inspect development servers when permitted.
- Launch Playwright browser sessions.
- Execute validated scenarios.
- Collect browser recordings, screenshots, logs, and traces.
- Run the rendering pipeline.
- Save artifacts locally.
- Report progress, results, and errors.
- Synchronize demo metadata with the website.
- Provide controlled playback access to local videos when authorized.

The Runner should not require publicly exposed inbound ports. Pairing should
use a short-lived code or another secure device-registration flow. Credentials
must be revocable and must not be the user's website password.

The Runner must validate job payloads and must not execute arbitrary shell
commands from untrusted requests.

### 3.3. DemoFlow MCP Server

MCP is a first-class interface for AI coding agents.

The MCP server should let compatible clients such as Claude Code and other
MCP-capable tools request demos without needing to understand the internals of
browser automation or video rendering.

Conceptual operations include:

- Check Runner and project availability.
- List registered projects.
- Create or validate a demo scenario.
- Generate and execute a demo.
- Check task status.
- Cancel a running task.
- Retrieve verification results.
- List recent demos.
- Retrieve artifact metadata and local paths.
- Retrieve the DemoFlow page reference for a video.

A high-level tool such as `generate_demo` should orchestrate the normal
workflow. Do not force an AI agent to send a separate MCP call for every mouse
movement or low-level browser action.

Long-running work should return a task ID and allow status checks rather than
holding a single MCP request open throughout recording and rendering.

MCP is the control interface, not the recording engine. The server should
delegate execution to the shared core and local Runner.

### 3.4. DemoFlow CLI

The CLI should expose the core workflow for developers, scripts, CI pipelines,
and agents that do not use MCP.

Illustrative commands:

```bash
demoflow login
demoflow runner connect
demoflow project add .
demoflow demo create --url http://localhost:3000
demoflow demo run ./demoflow/demo.json
demoflow demo list
demoflow demo status <task-id>
demoflow video open <video-id>
```

These commands are examples; the final interface should be designed around
real workflows.

The CLI should support:

- Account login and Runner pairing.
- Project registration.
- Running a demo scenario.
- Creating a scenario template.
- Starting, monitoring, and cancelling jobs.
- Listing demos and artifacts.
- Opening a video locally.
- Reading configuration and diagnostics.
- Machine-readable JSON output for automation.

The CLI and MCP server should share the same core logic and contracts rather
than implementing separate versions of the workflow.

### 3.5. npm packages and optional SDK

npm distribution is an important part of DemoFlow, but it should not mean that
every target application must install an SDK.

There are two different use cases:

**A. Installing DemoFlow tooling**

The CLI, MCP server, and related JavaScript/TypeScript tooling should be
installable through npm where practical. The Runner may use npm distribution
plus platform-specific browser/runtime dependencies.

**B. Integrating with the target application**

An optional SDK can be added to applications that need more precise control
over demonstrations.

Possible SDK capabilities:

- Mark important UI states or demo milestones.
- Add semantic annotations to a scenario.
- Identify elements that must be masked.
- Report that a particular state is ready.
- Attach application-specific metadata.
- Provide explicit start/end markers for a demonstration.

The SDK must remain optional. The basic product should be able to demonstrate
an ordinary web application without changing its source code, provided the
application can be opened by the Runner and controlled by Playwright.

The SDK should not automatically transmit application data. Its public API
should be defined after the core scenario format and use cases have been
validated.

### 3.6. DemoFlow Core

The shared core defines the common contracts used by the website, Runner, CLI,
MCP server, browser engine, and renderer.

It should cover:

- Demo and scenario models.
- Task lifecycle and status transitions.
- Validation rules.
- Project configuration.
- Recording and rendering contracts.
- Artifact metadata.
- Error types.
- Storage interfaces.
- Event and progress reporting.
- Version compatibility between components.

Keep the architecture modular, but avoid creating many packages or
microservices before there is a real need for independent deployment or
versioning.

## 4. Playwright and scenario execution

Playwright should be the initial browser automation engine.

It is responsible for opening the application, performing the steps in a
scenario, and checking the expected outcomes.

Supported scenario actions should include:

- Navigate to a page.
- Wait for a page or UI state.
- Click an element.
- Fill or select a form value.
- Hover over an element.
- Scroll a page or container.
- Assert visibility, text, or an expected state.
- Capture a screenshot.
- Mark a scene or important moment.
- Finish the scenario.

Prefer accessibility-based locators, labels, roles, and stable test IDs. Avoid
relying only on coordinates or fragile CSS selectors.

Scenarios should be stored in a versionable structured format, such as
validated JSON, with an optional TypeScript authoring API.

Illustrative scenario:

```json
{
  "name": "Create a customer",
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "action": "navigate", "path": "/customers" },
    { "action": "waitFor", "target": "[data-testid='customer-list']" },
    { "action": "click", "target": "[data-testid='create-customer']" },
    { "action": "verifyVisible", "target": "[data-testid='customer-form']" }
  ]
}
```

This is an illustrative schema, not an existing implementation.

A scenario may be authored by a developer, generated by an AI agent, reused
from a previous demo, or adapted from existing tests. AI-generated scenarios
must be validated before execution.

### Application startup

DemoFlow should support:

- A developer-provided URL.
- A configured local development command.
- A project-level DemoFlow configuration.
- A known test environment.

It should not assume every repository uses the same framework, package
manager, port, or startup command. Running project commands must be restricted
to registered projects and explicitly permitted operations.

### Verification

A successful recording does not automatically mean a successful demo.

The system should separately report:

- Application readiness.
- Scenario execution.
- Assertions and verification.
- Recording.
- Rendering.
- Artifact storage and availability.

A failed assertion must remain visible in the result. The renderer must not
make a failed interaction appear successful.

## 5. Recording and cinematic video rendering

The renderer is one of the product's most important differentiators.

The objective is to turn a functional browser session into a clear,
professional product demonstration.

### Desired effects

- Smooth animated cursor movement.
- Click indicators and subtle emphasis.
- Smooth scrolling.
- Zooming into important controls or content.
- Pan and focus transitions.
- Scene transitions.
- Optional opening and closing titles.
- Captions or short step labels.
- Removal of unnecessary pauses.
- Configurable video dimensions, frame rate, and aspect ratio.
- MP4 output as the primary format, with optional WebM or GIF exports.

### Recording versus rendering

Recording and rendering must be separate stages.

**Recording** captures the real browser session and relevant event metadata.

**Rendering** transforms the source recording, event timeline, screenshots, and
scene markers into the final presentation.

This separation allows the same source material to be rendered in different
styles without rerunning the scenario, provided the source artifacts contain
the necessary information.

Playwright can supply browser automation and recording capabilities. FFmpeg can
handle encoding, trimming, composition, and export. A separate rendering layer
may be needed for animated cursor movement, camera framing, and transitions.

Do not assume that a raw screen recording alone contains all information
needed for cinematic effects. Prototype the capture and rendering approach
early.

Visual effects must never fabricate successful application behavior or hide
meaningful errors.

## 6. DemoFlow website: core screens

### Dashboard

- Recent demos.
- Running tasks and progress.
- Connected Runners.
- Failed jobs and warnings.
- Quick action to create a demo.

### Projects

- Project name and optional description.
- Local repository association.
- Registered machines and environments.
- Application URL and startup configuration.
- Scenario collection.
- Demo history.

A project may have more than one working copy or environment.

### Runner management

- Register and pair a machine.
- Show connection status and last-seen time.
- Show Runner version and capabilities.
- Inspect active jobs.
- Revoke access or disconnect a machine.
- View relevant security events.

### Demo library

- Browse and search demos.
- Filter by project, date, and status.
- View duration and resolution.
- Distinguish raw recordings from rendered videos.
- Open the detail page.
- Inspect verification results.
- Access available local or cloud artifacts.

### Video detail page

- Video player.
- Demo title and project.
- Creation time, duration, resolution, and file size.
- Scenario summary.
- Execution and verification status.
- Rendering status.
- Artifact availability.
- Related screenshots, logs, and traces when enabled.
- Actions to play in the browser or open in Luna Player.

### Settings

- Default rendering style.
- Resolution and frame rate.
- Maximum demo duration.
- Browser preferences.
- Local artifact directory.
- Cloud upload policy.
- Masking rules.
- Retention and cleanup policy.

## 7. Local storage and cloud metadata

DemoFlow should use a local-first model.

By default:

- Source recordings remain local.
- Rendered videos remain local.
- Screenshots and traces remain local.
- The website stores the metadata needed to organize and display demo history.
- No video is uploaded automatically.

The web interface should distinguish clearly between:

1. **Local artifact:** a file on the user's computer.
2. **Runner playback:** a file served through an authenticated connection to an
   online Runner.
3. **Cloud artifact:** a file explicitly uploaded to configured cloud storage.
4. **Shareable link:** an authorized link with a defined access policy.

A page URL inside DemoFlow is not necessarily a direct video URL. When the
Runner is offline, a local-only video may be temporarily unavailable from the
website. The UI should communicate that honestly.

The Runner must track artifact metadata, detect missing files, and handle
deletion or relocation without silently claiming the video is still available.

## 8. Luna Player integration

Luna Player should be the preferred integrated playback option for generated
videos, while the browser player remains a fallback.

Desired flow:

1. The user opens a demo in the DemoFlow website.
2. The video detail page displays metadata and verification status.
3. The user chooses **Play in Luna Player**.
4. DemoFlow hands off the local or authorized video source through a mechanism
   supported by Luna Player.
5. If Luna Player is unavailable or the integration fails, the website offers
   browser playback when possible.

The integration must be implemented as an adapter, not a hard dependency in the
core.

Before implementation, inspect Luna Player and verify which interfaces it
actually supports: local-file opening, URL schemes, IPC, local APIs, streaming
sources, or other integration methods. Do not invent or assume these
capabilities.

A browser cannot automatically access arbitrary local filesystem paths. Local
playback must use an explicitly supported mechanism, such as a custom URL
scheme, a local companion interface, or an authenticated Runner endpoint.

> **Finding at project setup (2026-10-17):** `AndreyBegma/luna-player` is a
> React 19 DOM package, published to npm as `luna-player` (0.1.2 on
> 2026-10-17). Its player component is not implemented yet on `main` or
> `develop` — only logic and platform modules exist. It exposes no URL scheme,
> IPC or desktop-app interface.

## 9. Glass UI visual direction

The website should use **Glass UI** (`@andrewbehma/glass-ui`) as its visual
direction: a modern, polished interface with translucent surfaces, subtle blur,
restrained borders, layered depth, and clear visual hierarchy.

Glass UI is a design language, not a requirement to make every element
transparent.

### Visual principles

- Translucent panels with controlled backdrop blur.
- Subtle borders and highlights to separate layers.
- Restrained shadows and depth.
- Clear typography and readable contrast.
- Consistent spacing and alignment.
- Smooth but restrained transitions.
- High-quality dark theme, with a light theme considered if appropriate.
- Functional status indicators for running, completed, failed, and unavailable
  states.
- Video previews and progress indicators that feel integrated into the
  interface.

### Where to use glass effects

- Navigation and top bars.
- Dashboard summary cards.
- Floating action panels.
- Modal dialogs and contextual overlays.
- Video metadata panels.
- Runner connection status.
- Small floating controls around the video player.

### Where not to overuse glass

- Dense data tables.
- Long-form documentation.
- Code, logs, and error details.
- Small text over visually busy backgrounds.
- Every nested card or panel.

The interface must remain readable, accessible, and responsive. Blur and
transparency must not reduce contrast or obscure important states. Respect
reduced-motion preferences and avoid excessive animation.

The website should feel like a professional developer tool, not a decorative
concept mockup. Prioritize task status, video access, and actionable
diagnostics over visual effects.

## 10. Authentication and Runner pairing

The account and Runner session model must distinguish between:

- The user's website session.
- A registered machine.
- An active Runner connection.
- A running demo job.

Pairing should follow a secure device-registration flow:

1. The user signs into the website.
2. The website generates a short-lived pairing code.
3. The user runs the local Runner setup.
4. The Runner exchanges the code through an authenticated flow.
5. The user confirms the machine if needed.
6. The Runner receives a scoped, revocable device credential.
7. The machine appears in the account.

Use outbound connections from the Runner wherever practical so the user does
not need to expose a public inbound port. A persistent authenticated WebSocket
is one candidate; polling or another protocol may be evaluated during design.

The connection must handle reconnects, heartbeats, token rotation, task
cancellation, and temporary network failures.

## 11. Security and privacy

The Runner operates on the user's computer, so it must be designed with strict
boundaries.

Requirements:

- Access only to registered project directories.
- Explicit permissions for project commands and browser access.
- Validated scenario schemas and job payloads.
- No arbitrary shell execution from untrusted MCP inputs.
- Secure, revocable Runner credentials.
- No credentials or secrets in logs, screenshots, or video.
- Masking rules for sensitive UI elements.
- Clear control over which artifacts can be uploaded.
- Authenticated access to local playback.
- Protection against unsafe URLs and SSRF-like behavior where relevant.
- Explicit confirmation before actions that could affect production data.
- Clear artifact deletion and retention behavior.
- No automatic publication of videos.

DOM masking alone is not sufficient to guarantee privacy. Screenshots, source
recordings, rendered output, logs, and traces must all be considered.

Prefer test environments and synthetic data for automated demos.

## 12. Task lifecycle and reliability

Use explicit task states, for example:

`queued → preparing → executing → verifying → rendering → completed`

Other outcomes may include `failed`, `cancelled` and
`completed_with_warnings`.

A task must not be marked fully successful merely because an MP4 was created.

Handle:

- Application startup failure.
- Browser launch failure.
- Scenario timeout.
- Assertion failure.
- Runner disconnection.
- Recording failure.
- Rendering failure.
- Insufficient disk space.
- Missing or deleted artifacts.
- Permission errors.

Where possible, allow rendering to be retried from existing source artifacts
without rerunning a successful browser scenario. Use idempotency to avoid
duplicate jobs and duplicate uploads.

## 13. Suggested npm package structure

Package names are provisional. A monorepo can be used initially.

```text
packages/
  core/             # Shared models and business logic
  mcp/              # MCP server and tools
  cli/              # Command-line interface
  runner/           # Local execution agent
  scenario/         # Scenario schema and validation
  browser/          # Playwright integration
  capture/          # Recording and timeline metadata
  renderer/         # Video effects and export
  sdk/              # Optional application SDK
  player-adapter/   # Luna Player integration
apps/
  web/              # DemoFlow website
```

Do not create all packages as separate independently deployed services by
default. Start with logical modules and split them into separately versioned
packages where there is a clear need.

The actual distribution must account for Playwright browser dependencies and
platform-specific Runner requirements. npm installation alone does not
guarantee that all native and browser dependencies are installed on every OS.

## 14. Suggested data entities

Initial domain entities may include:

- **User:** account identity and preferences.
- **Workspace:** logical grouping of projects and machines, if needed.
- **Runner:** registered machine, status, version, and revocation state.
- **Project:** project identity and local associations.
- **Scenario:** versioned demo steps and expected outcomes.
- **DemoJob:** execution state, timing, and diagnostics.
- **DemoArtifact:** source video, rendered video, screenshot, trace, or log.
- **RenderProfile:** visual style and export settings.

This is a conceptual model, not a requirement to create a large database schema
before the MVP needs it.

## 15. Delivery phases

### Phase 1 — Validate the core technical risk

- Test Playwright scenario execution and recording.
- Prototype smooth cursor and scroll effects.
- Test the proposed video-rendering pipeline.
- Inspect Luna Player integration capabilities.
- Decide how local playback will work from the website.
- Define the Runner pairing model.

**Deliverable:** a short technical prototype that produces a credible demo
video.

### Phase 2 — Local MVP

- Scenario schema and validation.
- Playwright browser execution.
- Basic assertions.
- Recording and MP4 export.
- Local artifact storage.
- CLI commands and JSON output.

**Deliverable:** a developer can generate a demo locally without needing a
cloud account.

### Phase 3 — MCP integration

- MCP server.
- High-level demo-generation tool.
- Task IDs and status polling.
- Structured verification and artifact results.
- Useful errors for the AI agent.

**Deliverable:** Claude Code can request and retrieve a demo through MCP.

### Phase 4 — Video quality

- Animated cursor.
- Click emphasis.
- Smooth scrolling.
- Zoom and transitions.
- Scene markers and titles.
- Export settings.

**Deliverable:** the output looks like a product presentation rather than raw
test footage.

### Phase 5 — Website and Runner pairing

- Account and authentication.
- Runner registration.
- Secure pairing and reconnection.
- Project management.
- Demo history and library.
- Task progress.
- Local artifact availability states.

**Deliverable:** the website manages demos created on connected machines.

### Phase 6 — Luna Player

- Inspect and implement a supported integration.
- Open local artifacts safely.
- Show player availability and error states.
- Provide browser playback fallback.

**Deliverable:** users can play demos from the DemoFlow website using Luna
Player where supported.

### Phase 7 — Optional SDK and advanced integrations

- Add application annotations and masking.
- Reuse existing automated tests as demo scenarios where practical.
- Consider pull-request attachments and CI integrations.

**Deliverable:** deeper integrations without making the SDK mandatory.

## 16. MVP acceptance criteria

The MVP is ready when:

1. DemoFlow can run locally on its first supported platform.
2. Playwright can open a registered web application.
3. A structured scenario with multiple actions can execute.
4. Expected UI states are verified.
5. A source recording and final MP4 can be produced.
6. The video includes basic visual polish.
7. Artifacts and metadata are stored locally.
8. The CLI returns structured output.
9. An MCP client can start a demo and retrieve its result.
10. Failed verification is never reported as successful.
11. A connected Runner can synchronize demo metadata to the website.
12. The website shows the demo and correctly reports artifact availability.
13. Video upload is opt-in.
14. Luna Player integration uses a verified supported interface.
15. Runner access can be revoked and local artifacts can be deleted.

## 17. Important decisions to validate

Before committing to a full implementation, investigate:

- Which web stack and authentication approach best fit the platform.
- Whether Runner communication should use WebSocket, polling, or another
  protocol.
- How the site securely accesses local video files.
- Which APIs Luna Player already exposes.
- Which rendering technique produces the desired camera and cursor effects.
- Whether Chromium alone is sufficient for the MVP.
- How authenticated applications and test credentials should be handled.
- Which OS should be supported first.
- How MCP client authorization maps to Runner permissions.
- Exactly which metadata may be synchronized to the cloud.

Do not invent APIs or assume that existing projects support an integration
until their code or documentation has been inspected.

## 18. Product summary

DemoFlow is a standalone, MCP-first platform for creating polished and verified
browser-based product demonstrations.

It combines:

- **MCP** for AI-agent integration.
- **CLI** for terminal and automation workflows.
- **npm packages** for distribution and optional application integration.
- **Playwright** for browser scenarios and verification.
- **A rendering engine** for polished videos.
- **A local Runner** for secure execution on the developer's machine.
- **A web platform** for accounts, projects, machine sessions, and video
  history.
- **Local-first storage** with optional cloud hosting.
- **Luna Player** for integrated playback.
- **Glass UI** as the visual direction of the website.

The key architectural separation is between the control plane (website,
accounts, metadata, job coordination) and the execution plane (local Runner,
browser automation, recording, rendering, and local artifacts).

The first milestone should prove that DemoFlow can reliably turn a real browser
scenario into a polished video. The website, cloud synchronization, Luna Player
integration, and optional SDK should be built around that validated core.
