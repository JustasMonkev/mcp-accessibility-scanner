#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-mcp-accessibility-scanner:test}"
PORT="${MCP_DOCKER_SMOKE_PORT:-18931}"
CONTAINER_NAME="mcp-a11y-smoke-${RANDOM}-${RANDOM}"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[docker-smoke] Building ${IMAGE_TAG}"
docker build -t "${IMAGE_TAG}" .

echo "[docker-smoke] Verifying CLI version"
version_output="$(docker run --rm "${IMAGE_TAG}" --version)"
if [[ "${version_output}" != Version* ]]; then
  echo "[docker-smoke] Unexpected --version output: ${version_output}"
  exit 1
fi

echo "[docker-smoke] Verifying non-root user and nested init startup"
test "$(docker run --rm --entrypoint id "$IMAGE_TAG" -un)" = mcp
docker run --rm --init "$IMAGE_TAG" --version >/dev/null

echo "[docker-smoke] Verifying stdio startup"
stdio_response="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"1.0.0"}}}' | timeout 30s docker run --rm -i "$IMAGE_TAG")"
if [[ "$stdio_response" != *'"result"'* ]]; then
  echo "[docker-smoke] No MCP initialize response over stdio: $stdio_response"
  exit 1
fi

echo "[docker-smoke] Verifying Chromium launch inside container"
docker run --rm --entrypoint node "${IMAGE_TAG}" --input-type=module -e "import { chromium } from 'playwright-core'; const browser = await chromium.launch({ headless: true, chromiumSandbox: false }); await browser.close(); console.log('chromium-ok');"

echo "[docker-smoke] Starting MCP server container on localhost:${PORT}"
docker run -d --name "${CONTAINER_NAME}" -p "${PORT}:8931" "${IMAGE_TAG}" --host 0.0.0.0 --port 8931 --browser chromium --no-sandbox --isolated --output-dir /app/output >/dev/null

ready=0
for _ in $(seq 1 20); do
  http_code="$(curl -sS -o /tmp/mcp-docker-smoke-response.txt -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/mcp" -H 'content-type: application/json' -d '{}' 2>/dev/null || true)"
  if [[ "${http_code}" == "406" ]]; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "${ready}" != "1" ]]; then
  echo "[docker-smoke] MCP endpoint did not become ready on localhost:${PORT}"
  docker logs "${CONTAINER_NAME}" || true
  exit 1
fi

if [[ "$(docker exec "$CONTAINER_NAME" cat /proc/1/comm)" != "tini" ]]; then
  echo "[docker-smoke] Expected tini as PID 1"
  exit 1
fi

echo "[docker-smoke] Checking isolated browser session cleanup"
timeout 180s docker exec -i "$CONTAINER_NAME" node --input-type=module <<'NODE'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

for (let i = 0; i < 6; i++) {
  const client = new Client({ name: 'docker-smoke', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp')));
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'data:text/html,<title>Docker smoke</title>' },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    await client.callTool({ name: 'browser_close', arguments: {} });
  } finally {
    await client.close();
  }
}
NODE

zombies=1
for _ in $(seq 1 5); do
  zombies="$(docker exec "$CONTAINER_NAME" node --input-type=module -e "
    import fs from 'node:fs';
    const statuses = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))
      .flatMap(name => { try { return [fs.readFileSync('/proc/' + name + '/status', 'utf8')]; } catch { return []; } });
    console.log(statuses.filter(status => /^State:\s+Z/m.test(status)).length);
  ")"
  [[ "$zombies" == 0 ]] && break
  sleep 1
done
if [[ "$zombies" != 0 ]]; then
  echo "[docker-smoke] $zombies zombie processes remain after browser sessions closed"
  exit 1
fi

echo "[docker-smoke] Checking SIGTERM forwarding"
docker stop -t 10 "$CONTAINER_NAME" >/dev/null
if [[ "$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME")" == 137 ]]; then
  echo "[docker-smoke] Container required SIGKILL after SIGTERM"
  exit 1
fi

echo "[docker-smoke] MCP server is reachable and image is functional."
