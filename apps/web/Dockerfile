# DemoFlow web image. Built from the repository root:
#
#   docker build -t demoflow-web:staging -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://demoflow.example.com/api .
#
# NEXT_PUBLIC_API_URL is baked into the client bundle: it is a build argument,
# and changing it means rebuilding the image.

# ─── deps ────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN bun install --frozen-lockfile

# ─── builder ─────────────────────────────────────────────────────────────────
FROM deps AS builder

ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" \
  || (echo "NEXT_PUBLIC_API_URL build arg is required — the client bundle bakes it in." && exit 1)
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY tsconfig.json turbo.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN bunx turbo run build --filter=@demoflow/web...

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3670
# The standalone server binds 127.0.0.1 unless told otherwise.
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next

USER node

EXPOSE 3670

# Any answer under 500 means the server is up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3670)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
