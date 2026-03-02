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

echo "[docker-smoke] Verifying Chromium launch inside container"
docker run --rm --entrypoint node "${IMAGE_TAG}" --input-type=module -e "import { chromium } from 'playwright-core'; const browser = await chromium.launch({ headless: true, chromiumSandbox: false }); await browser.close(); console.log('chromium-ok');"

echo "[docker-smoke] Starting MCP server container on localhost:${PORT}"
docker run -d --name "${CONTAINER_NAME}" -p "${PORT}:8931" "${IMAGE_TAG}" --host 0.0.0.0 --port 8931 --browser chromium --no-sandbox --output-dir /app/output >/dev/null

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

echo "[docker-smoke] MCP server is reachable and image is functional."
