# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  PLAYWRIGHT_MCP_BROWSER=chromium \
  PLAYWRIGHT_MCP_HEADLESS=true \
  PLAYWRIGHT_MCP_OUTPUT_DIR=/app/output

WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY --from=build /app/skills ./skills
COPY --from=build /app/cli.js ./cli.js
COPY --from=build /app/index.js ./index.js
COPY --from=build /app/index.d.ts ./index.d.ts
COPY --from=build /app/config.d.ts ./config.d.ts
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/NOTICE.md ./NOTICE.md

RUN node ./node_modules/playwright-core/cli.js install --with-deps chromium \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system mcp \
  && useradd --system --gid mcp --create-home --shell /usr/sbin/nologin mcp \
  && mkdir -p /app/output /ms-playwright \
  && chown -R mcp:mcp /app /ms-playwright /home/mcp

USER mcp

EXPOSE 8931

# No image HEALTHCHECK: the default stdio mode opens no HTTP listener to probe.
# The HTTP service in docker-compose.yaml defines its own healthcheck.

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "node", "cli.js", "--no-sandbox"]
