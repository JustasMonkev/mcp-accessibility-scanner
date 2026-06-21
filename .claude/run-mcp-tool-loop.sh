#!/usr/bin/env bash
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPTS_FILE="$SCRIPT_DIR/mcp-tool-prompts.tsv"
SERVER_NAME="mcp-accessibility-scanner"
MAX_TURNS="${MAX_TURNS:-12}"
RUN_OPTIONAL=1
ONLY_TOOL=""

usage() {
  cat <<'USAGE'
Usage: .claude/run-mcp-tool-loop.sh [options]

Runs one Claude Code -p prompt per mcp-accessibility-scanner MCP tool and
writes JSONL logs plus a summary TSV under .claude/mcp-tool-loop-results/.

Options:
  --only TOOL          Run a single tool prompt.
  --skip-optional     Skip optional prompts such as browser_install.
  --prompts FILE      Use a custom TSV prompt file.
  --max-turns N       Override Claude Code max turns per prompt.
  -h, --help          Show this help.

Environment:
  MAX_TURNS=N         Default max turns if --max-turns is not provided.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      ONLY_TOOL="${2:-}"
      shift 2
      ;;
    --skip-optional)
      RUN_OPTIONAL=0
      shift
      ;;
    --prompts)
      PROMPTS_FILE="${2:-}"
      shift 2
      ;;
    --max-turns)
      MAX_TURNS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$PROMPTS_FILE" ]]; then
  echo "Prompt file not found: $PROMPTS_FILE" >&2
  exit 2
fi

cd "$PROJECT_ROOT"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found in PATH" >&2
  exit 2
fi

if ! claude auth status --text >/dev/null 2>&1; then
  echo "Claude Code is not logged in. Run: claude auth login" >&2
  exit 2
fi

if ! claude mcp get "$SERVER_NAME" >/dev/null 2>&1; then
  echo "MCP server '$SERVER_NAME' is not configured or not approved." >&2
  echo "Run: claude mcp get $SERVER_NAME" >&2
  echo "If it is pending approval, run: claude" >&2
  exit 2
fi

RUN_ID="$(date +%Y%m%d-%H%M%S)"
RESULTS_DIR="$SCRIPT_DIR/mcp-tool-loop-results/$RUN_ID"
mkdir -p "$RESULTS_DIR"

UPLOAD_FILE="$RESULTS_DIR/mcp-upload.txt"
printf 'mcp upload fixture\n' > "$UPLOAD_FILE"

SUMMARY_FILE="$RESULTS_DIR/summary.tsv"
printf 'tool\tcategory\tstatus\texit_code\tlog\n' > "$SUMMARY_FILE"

summarize_log() {
  local tool="$1"
  local log_file="$2"
  node - "$tool" "$log_file" <<'NODE'
const fs = require('fs');
const tool = process.argv[2];
const logFile = process.argv[3];
const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split(/\n+/).filter(Boolean) : [];
const expectedSuffix = `__${tool}`;
const seenTools = new Set();
let result = '';
let isError = false;

function visit(value) {
  if (!value || typeof value !== 'object')
    return;
  if (typeof value.name === 'string') {
    if (value.name === tool || value.name.endsWith(expectedSuffix) || value.name.includes(`__${tool}`))
      seenTools.add(value.name);
  }
  if (Array.isArray(value)) {
    for (const item of value)
      visit(item);
    return;
  }
  for (const item of Object.values(value))
    visit(item);
}

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  visit(event);
  if (event.type === 'result') {
    result = String(event.result ?? '');
    isError = Boolean(event.is_error);
  }
}

const hasPass = /\bPASS\b/i.test(result);
const hasFail = /\bFAIL\b/i.test(result);
const sawTarget = seenTools.size > 0;

if (isError)
  console.log('ERROR_RESULT');
else if (hasPass && sawTarget)
  console.log('PASS');
else if (hasPass && !sawTarget)
  console.log('PASS_NO_TOOL_TRACE');
else if (hasFail)
  console.log('FAIL');
else
  console.log('UNKNOWN');
NODE
}

total=0
passed=0
failed=0

while IFS=$'\t' read -r tool category prompt; do
  [[ -z "${tool:-}" || "${tool:0:1}" == "#" ]] && continue
  [[ -n "$ONLY_TOOL" && "$tool" != "$ONLY_TOOL" ]] && continue
  [[ "$category" == "optional" && "$RUN_OPTIONAL" -eq 0 ]] && continue

  total=$((total + 1))
  safe_tool="${tool//[^A-Za-z0-9_.-]/_}"
  log_file="$RESULTS_DIR/$(printf '%02d' "$total")-$safe_tool.jsonl"
  err_file="$RESULTS_DIR/$(printf '%02d' "$total")-$safe_tool.stderr"

  prompt="${prompt//__UPLOAD_FILE__/$UPLOAD_FILE}"
  prompt="${prompt//__RESULTS_DIR__/$RESULTS_DIR}"

  echo "[$total] $tool"
  if claude -p \
      --output-format stream-json \
      --verbose \
      --max-turns "$MAX_TURNS" \
      "$prompt" >"$log_file" 2>"$err_file"; then
    exit_code=0
  else
    exit_code=$?
  fi

  if [[ "$exit_code" -eq 0 ]]; then
    status="$(summarize_log "$tool" "$log_file")"
  else
    status="CLI_EXIT_$exit_code"
  fi

  case "$status" in
    PASS|PASS_NO_TOOL_TRACE)
      passed=$((passed + 1))
      ;;
    *)
      failed=$((failed + 1))
      ;;
  esac

  printf '%s\t%s\t%s\t%s\t%s\n' "$tool" "$category" "$status" "$exit_code" "$log_file" | tee -a "$SUMMARY_FILE"
done < "$PROMPTS_FILE"

echo
echo "Results directory: $RESULTS_DIR"
echo "Summary: $SUMMARY_FILE"
echo "Passed: $passed / $total"
echo "Failed: $failed / $total"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
