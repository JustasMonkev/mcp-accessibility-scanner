# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  PLAYWRIGHT_MCP_BROWSER=chromium \
  PLAYWRIGHT_MCP_HEADLESS=true \
  PLAYWRIGHT_MCP_OUTPUT_DIR=/app/output

WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY --from=build /app/cli.js ./cli.js
COPY --from=build /app/index.js ./index.js
COPY --from=build /app/index.d.ts ./index.d.ts
COPY --from=build /app/config.d.ts ./config.d.ts
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/NOTICE.md ./NOTICE.md

RUN node ./node_modules/playwright-core/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system mcp \
  && useradd --system --gid mcp --create-home --shell /usr/sbin/nologin mcp \
  && mkdir -p /app/output /ms-playwright \
  && chown -R mcp:mcp /app /ms-playwright /home/mcp

USER mcp

EXPOSE 8931

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); const req = http.request({hostname:'localhost',port:8931,path:'/mcp',method:'POST',headers:{'content-type':'application/json'}}, res => process.exit(res.statusCode === 406 ? 0 : 1)); req.on('error', () => process.exit(1)); req.end('{}');"

ENTRYPOINT ["node", "cli.js", "--no-sandbox"]
