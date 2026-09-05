#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const serverName = 'mcp-accessibility-scanner';
const model = 'gpt-5.6-luna';
const reasoningEffort = 'xhigh';
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exit(0);
}

const promptsPath = path.resolve(projectRoot, options.prompts || '.codex/mcp-tool-prompts.tsv');
const schemaPath = path.join(scriptDir, 'luna-result.schema.json');
const entries = readPrompts(promptsPath);
const selected = entries
    .filter(entry => !options.only || entry.tool === options.only)
    .filter(entry => options.includeOptional || entry.category !== 'optional')
    .slice(0, options.limit ?? entries.length);

if (!selected.length)
  fail(`No prompts matched${options.only ? ` --only ${options.only}` : ''}.`);

const codex = process.env.CODEX_BIN || 'codex';
checkCodex(codex);
const loginStatus = checkCodexLogin(codex);
if (!loginStatus.ok)
  fail(loginStatus.message);

const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const resultsDir = path.join(path.resolve(process.env.MCP_HARNESS_RESULTS_DIR || path.join(projectRoot, 'test-results')), 'mcp-tool-loop-results', runId);
fs.mkdirSync(resultsDir, { recursive: true });
const uploadPath = path.join(resultsDir, 'mcp-upload.txt');
fs.writeFileSync(uploadPath, 'mcp upload fixture\n');
const summaryPath = path.join(resultsDir, 'summary.tsv');
fs.writeFileSync(summaryPath, 'tool\tcategory\tstatus\texit_code\tlog\tevidence\n');
fs.writeFileSync(path.join(resultsDir, 'run.json'), JSON.stringify({
  model,
  reasoningEffort,
  serverName,
  prompts: promptsPath,
  startedAt: new Date().toISOString(),
}, null, 2));

let passed = 0;
let failed = 0;
let activeKill;
let interrupted = false;
const needsFixture = selected.some(entry => entry.prompt.includes('__FIXTURE_URL__'));
const fixture = needsFixture ? await startFixtureServer() : undefined;

const forwardSignal = signal => {
  interrupted = true;
  activeKill?.(signal);
};
process.on('SIGINT', forwardSignal);
process.on('SIGTERM', forwardSignal);

try {
  for (const [index, entry] of selected.entries()) {
    if (interrupted)
      break;
    const safeTool = entry.tool.replace(/[^A-Za-z0-9_.-]/g, '_');
    const prefix = `${String(index + 1).padStart(2, '0')}-${safeTool}`;
    const logPath = path.join(resultsDir, `${prefix}.jsonl`);
    const errorPath = path.join(resultsDir, `${prefix}.stderr`);
    const finalPath = path.join(resultsDir, `${prefix}.result.json`);
    const prompt = `${entry.prompt.replaceAll('__UPLOAD_FILE__', uploadPath).replaceAll('__RESULTS_DIR__', resultsDir).replaceAll('__FIXTURE_URL__', fixture?.url || '')}

Harness result contract (takes precedence over the requested display format): perform the requested MCP calls, then return a JSON object matching the supplied schema. Set status to PASS only when the requested check really passed. Set tool to exactly ${JSON.stringify(entry.tool)}. Put concrete observed output or state in evidence. Set status to FAIL when the check fails.`;

    process.stdout.write(`[${index + 1}/${selected.length}] ${entry.tool} ... `);
    const execution = await runCodex(codex, prompt, {
      logPath,
      errorPath,
      finalPath,
      resultsDir,
      uploadPath,
    });
    const result = summarize(execution, entry.tool, logPath, finalPath);
    const detail = result.evidence.replace(/\s+/g, ' ').slice(0, 300);
    fs.appendFileSync(summaryPath, `${entry.tool}\t${entry.category}\t${result.status}\t${execution.exitCode ?? ''}\t${logPath}\t${detail}\n`);

    if (result.status === 'PASS') {
      passed++;
      console.log('PASS');
    } else {
      failed++;
      console.log(`FAIL (${result.status})`);
      if (options.failFast)
        break;
    }
  }
} finally {
  process.off('SIGINT', forwardSignal);
  process.off('SIGTERM', forwardSignal);
  await fixture?.close();
}

console.log('');
console.log(`Results directory: ${resultsDir}`);
console.log(`Summary: ${summaryPath}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (interrupted) {
  console.log('Interrupted');
  process.exitCode = 130;
} else if (failed) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const parsed = {
    only: '',
    prompts: '',
    includeOptional: true,
    limit: undefined,
    timeoutSeconds: Number(process.env.EXEC_TIMEOUT_SECONDS || 120),
    failFast: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--only')
      parsed.only = requiredValue(args, ++i, '--only');
     else if (arg === '--skip-optional')
      parsed.includeOptional = false;
     else if (arg === '--prompts')
      parsed.prompts = requiredValue(args, ++i, '--prompts');
     else if (arg === '--limit')
      parsed.limit = positiveInteger(args[++i], '--limit');
     else if (arg === '--timeout')
      parsed.timeoutSeconds = positiveNumber(args[++i], '--timeout');
     else if (arg === '--fail-fast')
      parsed.failFast = true;
     else if (arg === '-h' || arg === '--help')
      parsed.help = true;
     else
      fail(`Unknown argument: ${arg}`);

  }

  if (!Number.isFinite(parsed.timeoutSeconds) || parsed.timeoutSeconds <= 0)
    fail('--timeout must be a positive number of seconds.');
  if (parsed.timeoutSeconds > 2_147_483.647)
    fail('--timeout must not exceed 2147483.647 seconds (Node timer limit).');
  return parsed;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-'))
    fail(`${flag} needs a value.`);
  return value;
}

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0)
    fail(`${flag} must be a positive integer.`);
  return number;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    fail(`${flag} must be a positive number.`);
  return number;
}

function readPrompts(filePath) {
  if (!fs.existsSync(filePath))
    fail(`Prompt file not found: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line, lineNumber) => {
    if (!line || line.startsWith('#'))
      return [];
    const [tool, category, ...promptParts] = line.split('\t');
    const prompt = promptParts.join('\t');
    if (!tool || !category || !prompt)
      fail(`Invalid prompt row at ${filePath}:${lineNumber + 1}`);
    return [{ tool, category, prompt }];
  });
}

function checkCodex(command) {
  const help = spawnSync(command, ['exec', '--help'], {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (help.error?.code === 'ETIMEDOUT')
    fail('Codex CLI did not finish exec --help within 5 seconds.');
  if (help.error)
    fail(`Codex CLI not found in PATH: ${command}`);
  if (help.signal)
    fail(`Codex CLI did not finish exec --help (${help.signal}).`);
  if (help.status !== 0)
    fail(`Codex CLI rejected exec --help (exit ${help.status}).`);
  for (const flag of ['--ignore-user-config', '--ephemeral', '--json', '--model', '--sandbox', '--output-schema', '--output-last-message']) {
    if (!`${help.stdout}\n${help.stderr}`.includes(flag))
      fail(`Codex CLI is missing required flag ${flag}.`);
  }
}

function checkCodexLogin(command) {
  const status = spawnSync(command, ['login', 'status'], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (status.error?.code === 'ETIMEDOUT')
    return { ok: false, message: 'Codex login status did not finish within 5 seconds.' };
  if (status.error)
    return { ok: false, message: `Codex login status failed: ${status.error.message}` };
  if (status.signal)
    return { ok: false, message: `Codex login status did not finish (${status.signal}).` };
  if (status.status !== 0) {
    const detail = `${status.stdout}\n${status.stderr}`.trim();
    return { ok: false, message: `Codex login status failed (exit ${status.status})${detail ? `: ${detail}` : '.'}` };
  }
  return { ok: true };
}

function startFixtureServer() {
  const body = '<!doctype html><html><head><title>Luna audit fixture</title></head><body><main><h1>Luna audit fixture</h1></main></body></html>';
  const server = http.createServer((request, response) => {
    if (request.url !== '/audit-site') {
      response.writeHead(404, { connection: 'close' });
      response.end();
      return;
    }
    response.writeHead(200, { 'connection': 'close', 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP port.'));
        return;
      }
      resolve({ url: `http://127.0.0.1:${address.port}/audit-site`, close: () => closeFixtureServer(server) });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeFixtureServer(server) {
  if (!server.listening)
    return Promise.resolve();
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function runCodex(command, prompt, paths) {
  const mcpArgs = JSON.stringify([
    'cli.js',
    '--headless',
    '--no-sandbox',
    '--isolated',
    '--output-dir',
    paths.resultsDir,
    '--allowed-upload-dirs',
    paths.resultsDir,
  ]);
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '--model',
    model,
    '--sandbox',
    'read-only',
    '--cd',
    projectRoot,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    paths.finalPath,
    '-c',
    'approval_policy="on-request"',
    '-c',
    'approvals_reviewer="auto_review"',
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    '-c',
    `mcp_servers.${serverName}.command="node"`,
    '-c',
    `mcp_servers.${serverName}.args=${mcpArgs}`,
    '-c',
    `mcp_servers.${serverName}.required=true`,
    prompt,
  ];

  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  let killTimer;
  let streamError;
  const killTree = signal => {
    if (child.pid && process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000, stdio: 'ignore' });
      return;
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process group may already have exited.
      }
    }
    child.kill(signal);
  };
  activeKill = signal => {
    killTree(signal);
    if (!killTimer && signal !== 'SIGKILL')
      killTimer = setTimeout(() => killTree('SIGKILL'), 2000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    activeKill?.('SIGTERM');
  }, options.timeoutSeconds * 1000);
  const streamFailed = error => {
    streamError ||= error;
    killTree('SIGKILL');
  };
  const logs = Promise.all([
    pipeline(child.stdout, fs.createWriteStream(paths.logPath)).catch(streamFailed),
    pipeline(child.stderr, fs.createWriteStream(paths.errorPath)).catch(streamFailed),
  ]);
  try {
    const execution = await new Promise(resolve => {
      child.once('error', error => resolve({ exitCode: null, signal: null, error }));
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await logs;
    return { ...execution, error: streamError || execution.error, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    activeKill = undefined;
    // Dispose any MCP descendants even when the CLI leader exits normally.
    killTree('SIGKILL');
  }
}

function summarize(execution, tool, logPath, finalPath) {
  if (execution.timedOut)
    return { status: 'TIMEOUT', evidence: `Codex exceeded ${options.timeoutSeconds}s; see ${logPath}.` };
  if (execution.error)
    return { status: 'CLI_ERROR', evidence: execution.error.message };
  if (execution.exitCode !== 0)
    return { status: `CLI_EXIT_${execution.exitCode ?? 'SIGNAL'}`, evidence: `Codex exited with ${execution.exitCode ?? execution.signal}.` };

  let events;
  try {
    events = readJsonLines(logPath);
  } catch (error) {
    return { status: 'INVALID_LOG', evidence: error.message };
  }
  const mcpCalls = collectMcpCalls(events);
  const targetCalls = mcpCalls.filter(call => call.server === serverName && call.tool === tool);
  const successfulTarget = targetCalls.some(call => call.completed && !call.failed && call.result);
  const failedMcp = mcpCalls.some(call => call.failed || call.result?.isError === true || !call.completed);
  const turnCompleted = events.some(event => event.type === 'turn.completed');
  let turnStarted = false;
  const globalFailure = events.some(event => {
    if (event.type === 'turn.started')
      turnStarted = true;
    if (event.type === 'error')
      return !turnCompleted || !isTransientReconnecting(event);
    return event.type === 'turn.failed' ||
      (event.item?.type === 'error' && (turnStarted || !isAllowedStartupWarning(event.item.message)));
  }) || !turnCompleted;
  let final;
  try {
    final = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
  } catch (error) {
    return { status: 'INVALID_RESULT', evidence: `Missing or invalid structured result: ${error.message}` };
  }

  if (!final || typeof final !== 'object' || Array.isArray(final) ||
      !['PASS', 'FAIL'].includes(final.status) || typeof final.tool !== 'string' ||
      typeof final.evidence !== 'string' || !final.evidence.trim())
    return { status: 'INVALID_RESULT', evidence: 'Structured result must include status, tool, and nonempty evidence.' };
  if (globalFailure)
    return { status: 'TURN_FAILED', evidence: final.evidence || 'Codex reported a failed turn.' };
  if (failedMcp)
    return { status: 'MCP_TOOL_FAILED', evidence: final.evidence || 'At least one MCP call failed or did not complete.' };
  if (!successfulTarget)
    return { status: 'NO_TOOL_EVIDENCE', evidence: final.evidence || `No successful ${tool} MCP call was recorded.` };
  if (final.status !== 'PASS')
    return { status: 'MODEL_FAIL', evidence: final.evidence || 'The structured result reported FAIL.' };
  if (final.tool !== tool)
    return { status: 'TOOL_MISMATCH', evidence: `Structured result named ${JSON.stringify(final.tool)}.` };
  if (typeof final.evidence !== 'string' || !final.evidence.trim())
    return { status: 'NO_EVIDENCE', evidence: 'Structured result did not include evidence.' };
  return { status: 'PASS', evidence: final.evidence };
}

function collectMcpCalls(events) {
  const calls = new Map();
  for (const event of events) {
    const item = event.item;
    if (item?.type !== 'mcp_tool_call')
      continue;
    const key = item.id || `${item.server}:${item.tool}:${calls.size}`;
    const call = calls.get(key) || { server: item.server, tool: item.tool, completed: false, failed: false };
    call.completed ||= event.type === 'item.completed' && item.status === 'completed';
    call.failed ||= Boolean(item.error) || item.status === 'failed';
    if (item.result !== undefined)
      call.result = item.result;
    calls.set(key, call);
  }
  return [...calls.values()];
}

function isAllowedStartupWarning(message) {
  return typeof message === 'string' && message.startsWith('Ignoring malformed agent role definition:');
}

function isTransientReconnecting(event) {
  if (event.type !== 'error')
    return false;
  const message = typeof event.message === 'string' ? event.message :
    typeof event.error?.message === 'string' ? event.error.message : event.error;
  return typeof message === 'string' && /^Reconnecting\.\.\.\s+\d+\/\d+(?:\b|$)/.test(message.trim());
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim())
      return [];
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || typeof event.type !== 'string')
        throw new Error('Expected an event object with a type.');
      return [event];
    } catch (error) {
      throw new Error(`Invalid Codex JSONL at line ${index + 1}: ${error.message}`, { cause: error });
    }
  });
}

function printUsage() {
  console.log(`Usage: node .codex/run-mcp-tool-loop.mjs [options]

Runs one Codex gpt-5.6-luna exec per mcp-accessibility-scanner prompt with
xhigh reasoning, a repo-scoped MCP server, structured evidence, and bounded
cleanup. Results are written to test-results/mcp-tool-loop-results/.

Options:
  --only TOOL          Run one tool prompt.
  --skip-optional     Skip optional prompts such as browser_install.
  --prompts FILE      Use a custom TSV prompt file.
  --limit N            Run at most N prompts in file order.
  --timeout SECONDS   Bound each Codex process (default: 120).
  --fail-fast         Stop after the first failed prompt.
  -h, --help          Show this help.

Environment:
  EXEC_TIMEOUT_SECONDS=N  Default per-process timeout.
  CODEX_BIN=PATH          Codex executable (default: codex).
`);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
