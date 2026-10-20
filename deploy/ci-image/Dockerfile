# The image the Woodpecker check steps run on: `demoflow-ci:node-bun`.
# The pipeline's first step builds it on the agent host's daemon (no registry)
# on push and manual runs only; pull requests reuse the tag the last push built
# (ADR-0011), so a change here reaches pull requests once it is merged. Not under
# .woodpecker/: Woodpecker reads every entry there as a workflow.
#
# bun is a literal, the one package.json `packageManager` pins; moving bun is
# one commit touching it, bun.lock, this file and the app Dockerfiles.
FROM node:24.20.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git \
    && rm -rf /var/lib/apt/lists/*

# Browser tests: FFmpeg (the engine's video checks) and the system libraries
# Playwright's Chromium needs (the list `playwright install-deps chromium`
# resolves on Debian bookworm, plus fonts). The Chromium build itself is not
# here: the pipeline installs it with the repository's own `playwright`, so the
# browser always matches the pin in packages/engine. Baking the libraries in
# keeps apt out of every run.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-liberation fonts-noto-color-emoji fonts-unifont \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
      libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
ENV PATH=/root/.bun/bin:$PATH
