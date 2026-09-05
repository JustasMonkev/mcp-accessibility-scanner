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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runner = path.resolve('.codex/run-mcp-tool-loop.mjs');
let fixtureDir: string;
let binary: string;
const fixture = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const mode = process.env.LUNA_CASE;
const invocationFile = process.env.LUNA_INVOCATION_FILE;
if (invocationFile)
  fs.appendFileSync(invocationFile, JSON.stringify(args) + '\n');
if (args[0] === 'login' && args[1] === 'status') {
  if (mode === 'auth-hang')
    setInterval(() => {}, 1000);
  else if (mode === 'auth-logged-out') {
    console.error('Not logged in');
    process.exitCode = 1;
  } else {
    console.log('Logged in using test credentials');
  }
} else if (args.includes('--help')) {
  if (mode === 'preflight-hang')
    setInterval(() => {}, 1000);
  else
    console.log('--ignore-user-config --ephemeral --json --model --sandbox --output-schema --output-last-message');
} else {
  if (args[args.indexOf('--model') + 1] !== 'gpt-5.6-luna' ||
      args[args.indexOf('--sandbox') + 1] !== 'read-only' ||
      !args.includes('model_reasoning_effort="xhigh"')) process.exit(9);
  const final = args[args.indexOf('--output-last-message') + 1];
  const prompt = args.at(-1);
  const emit = event => console.log(JSON.stringify(event));
  const call = (id, tool, status = 'completed') => ({type:'item.completed', item:{id, type:'mcp_tool_call', server:'mcp-accessibility-scanner', tool, status, result:{content:[]}}});
  fs.writeFileSync(process.env.LUNA_PID_FILE, String(process.pid));
  if (mode === 'hang' || mode === 'log-error') {
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    console.error('test log');
    setInterval(() => {}, 1000);
  } else {
    const targetTool = mode === 'fixture-audit' ? 'audit_site' : 'browser_navigate';
    const finish = () => {
      if (mode === 'startup-warning') emit({type:'item.completed',item:{type:'error',message:'Ignoring malformed agent role definition: local role'}});
      emit({type:'turn.started'});
      if (mode === 'reconnecting') emit({type:'error',message:'Reconnecting... 1/5'});
      if (mode !== 'no-call') {
        emit(call('target', 'browser_navigate'));
        if (targetTool === 'audit_site') emit(call('audit', 'audit_site'));
      }
      if (mode === 'other-failure') emit(call('verify', 'browser_evaluate', 'failed'));
      if (mode === 'incomplete') emit({type:'item.started',item:{id:'unfinished',type:'mcp_tool_call',server:'mcp-accessibility-scanner',tool:'browser_evaluate',status:'in_progress'}});
      if (mode === 'tool-error') { const event=call('err','browser_evaluate'); event.item.result.isError=true; emit(event); }
      if (mode === 'global-error') emit({type:'item.completed',item:{type:'error',message:'Model failed'}});
      if (mode === 'top-level-error') emit({type:'error',message:'Fatal connection error'});
      if (mode === 'terminal-reconnecting') {
        emit({type:'error',message:'Reconnecting... 5/5'});
        emit({type:'turn.failed',error:{message:'Connection retries exhausted'}});
      }
      if (mode === 'bad-log') console.log('{broken');
      if (mode !== 'no-completion' && mode !== 'terminal-reconnecting') emit({type:'turn.completed'});
      fs.writeFileSync(final, JSON.stringify({status:mode === 'model-fail' ? 'FAIL':'PASS', tool:targetTool, evidence: mode === 'bad-result' ? {} : mode === 'fixture-audit' ? 'Scanned pages: 1; Errored pages: 0' : 'Observed target result'}));
      if (mode === 'nonzero') process.exitCode=1;
    };
    if (mode === 'fixture-audit') {
      const url = prompt.match(/http:\/\/127\.0\.0\.1:\d+\/audit-site/)?.[0];
      if (!url) {
        console.error('fixture URL was not substituted');
        process.exitCode = 1;
      } else {
        fs.writeFileSync(process.env.LUNA_URL_FILE, url);
        http.get(url, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => body += chunk);
          response.on('end', () => {
            if (response.statusCode !== 200 || !body.includes('Luna audit fixture')) {
              console.error('fixture response was not usable');
              process.exitCode = 1;
            } else {
              finish();
            }
          });
        }).on('error', error => {
          console.error(error.message);
          process.exitCode = 1;
        });
      }
    } else {
      finish();
    }
  }
}
`;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-harness-test-'));
  binary = path.join(fixtureDir, 'codex.cjs');
  fs.writeFileSync(binary, fixture, { mode: 0o755 });
});
afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

async function run(mode: string, args: string[] = [], cancel = false, extraEnv: Record<string, string> = {}) {
  const pidFile = path.join(fixtureDir, `${mode}-${Date.now()}.pid`);
  const defaultOnly = args.includes('--only') ? [] : ['--only', 'browser_navigate'];
  const child = spawn(process.execPath, [runner, ...defaultOnly, ...args], {
    env: { ...process.env, CODEX_BIN: binary, MCP_HARNESS_RESULTS_DIR: fixtureDir, LUNA_CASE: mode, LUNA_PID_FILE: pidFile, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => output += data.toString());
  child.stderr.on('data', data => output += data.toString());
  const cancelTimer = cancel ? setInterval(() => {
    if (fs.existsSync(pidFile))
      child.kill('SIGINT');
  }, 100) : undefined;
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, output, pid: fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined };
  } finally {
    clearTimeout(deadline);
    clearInterval(cancelTimer);
    const results = output.match(/Results directory: (.+)/)?.[1];
    if (results && path.dirname(results) === path.join(fixtureDir, 'mcp-tool-loop-results'))
      fs.rmSync(results, { recursive: true, force: true });
  }
}

// The fake executable uses a POSIX shebang and signal handling, not a Windows launcher.
describe.skipIf(process.platform === 'win32')('Luna harness CLI', () => {
  it.each(['success', 'startup-warning', 'reconnecting'])('accepts a real successful tool trace: %s', async mode => {
    const result = await run(mode);
    expect(result.output).toContain('Passed: 1');
    expect(result.code).toBe(0);
  });

  it.each(['no-call', 'other-failure', 'incomplete', 'tool-error', 'global-error', 'top-level-error', 'terminal-reconnecting', 'bad-log', 'no-completion', 'bad-result', 'model-fail', 'nonzero'])('rejects false PASS: %s', async mode => {
    const result = await run(mode);
    expect(result.output).toContain('Failed: 1');
    expect(result.code).toBe(1);
  });

  it.each([false, true])('kills a resistant child on timeout/cancel: cancel=%s', async cancel => {
    const result = await run('hang', ['--timeout', cancel ? '60' : '1'], cancel);
    expect(result.code).toBe(cancel ? 130 : 1);
    expect(result.output).toContain(cancel ? 'Interrupted' : 'TIMEOUT');
    expect(result.pid).toBeDefined();
    expect(() => process.kill(result.pid!, 0)).toThrow();
  });

  it('bounds a hung CLI preflight', async () => {
    const result = await run('preflight-hang');
    expect(result.code).toBe(2);
    expect(result.output).toContain('within 5 seconds');
  });

  it('rejects a missing CLI before login status', async () => {
    const result = await run('success', [], false, { CODEX_BIN: path.join(fixtureDir, 'missing-codex') });
    expect(result.code).toBe(2);
    expect(result.output).toContain('Codex CLI not found in PATH');
    expect(result.pid).toBeUndefined();
  });

  it.each(['auth-logged-out', 'auth-hang'])('runs bounded login status before prompts: %s', async mode => {
    const invocationFile = path.join(fixtureDir, `${mode}-invocations.jsonl`);
    const result = await run(mode, [], false, { LUNA_INVOCATION_FILE: invocationFile });
    expect(result.code).toBe(2);
    expect(result.output).toContain(mode === 'auth-hang' ? 'within 5 seconds' : 'login status failed');
    const invocations = fs.readFileSync(invocationFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(invocations).toEqual([['exec', '--help'], ['login', 'status']]);
  });

  it('uses a loopback audit fixture and closes it after the run', async () => {
    const promptsPath = path.join(fixtureDir, 'fixture-prompts.tsv');
    const urlFile = path.join(fixtureDir, 'fixture-url.txt');
    fs.writeFileSync(promptsPath, 'audit_site\trequired\tUse __FIXTURE_URL__ and report one scanned page and zero errors.\n');
    const result = await run('fixture-audit', ['--only', 'audit_site', '--prompts', promptsPath], false, { LUNA_URL_FILE: urlFile });
    expect(result.code).toBe(0);
    expect(result.output).toContain('Passed: 1');
    const url = fs.readFileSync(urlFile, 'utf8');
    expect(new URL(url).hostname).toBe('127.0.0.1');
    await expect(new Promise<void>((resolve, reject) => {
      const request = http.get(url, () => reject(new Error('fixture server is still listening')));
      request.once('error', () => resolve());
      request.setTimeout(500, () => {
        request.destroy();
        reject(new Error('fixture server did not close'));
      });
    })).resolves.toBeUndefined();
  });

  it('kills the child when writing a log fails', async () => {
    const preload = path.join(fixtureDir, 'disk-error.cjs');
    fs.writeFileSync(preload, `const fs = require('node:fs'); const { Writable } = require('node:stream'); const original = fs.createWriteStream;
fs.createWriteStream = (file, ...args) => String(file).endsWith('.stderr') ? new Writable({write(chunk, encoding, done) {done(new Error('simulated disk full'));}}) : original(file, ...args);`);
    const result = await run('log-error', [], false, { NODE_OPTIONS: `--require=${preload}` });
    expect(result.code).toBe(1);
    expect(result.output).toContain('CLI_ERROR');
    expect(result.pid).toBeDefined();
    expect(() => process.kill(result.pid!, 0)).toThrow();
  });

  it.each([['--only'], ['--prompts'], ['--timeout', '0'], ['--limit', '0']])('rejects invalid options: %j', async (...args) => {
    const result = await run('success', args);
    expect(result.code).toBe(2);
    expect(result.pid).toBeUndefined();
  });

  it.each(['cli', 'env'])('enforces the Node timer boundary for %s timeouts', async source => {
    for (const value of ['2147483.647', '2147483.648']) {
      const result = await run('success', source === 'cli' ? ['--timeout', value] : [], false,
          source === 'env' ? { EXEC_TIMEOUT_SECONDS: value } : {});
      if (value === '2147483.647') {
        expect(result.code).toBe(0);
        expect(result.output).toContain('Passed: 1');
      } else {
        expect(result.code).toBe(2);
        expect(result.output).toContain('Node timer limit');
        expect(result.pid).toBeUndefined();
      }
      expect(result.output).not.toContain('TimeoutOverflowWarning');
    }
  });
});
