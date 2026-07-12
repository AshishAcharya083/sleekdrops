# SleekDrops agent platform → Cloud Run.
# One container: admin API + worker + scheduler + the built admin panel,
# run with tsx exactly like ./up.sh does locally (migrations live in src/).
#
# The admin panel is copied in PREBUILT — run this first:
#   pnpm --filter @sleekdrops/admin build
# (building it in-image needs esbuild, whose Go runtime crashes under the
# QEMU amd64 emulation used for cross-builds from Apple Silicon).
FROM node:22-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.0 --activate

# Workspace manifests first so dependency layers cache across code changes.
# admin/web ship only their manifests — the lockfile needs them to resolve.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/agent/package.json apps/agent/
COPY apps/admin/package.json apps/admin/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @sleekdrops/agent...

COPY apps/agent apps/agent
COPY apps/admin/dist apps/admin/dist

ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@sleekdrops/agent", "start"]
