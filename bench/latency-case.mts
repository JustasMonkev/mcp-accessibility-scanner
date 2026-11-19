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

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { z } from 'zod';

const root = path.resolve(import.meta.dirname, '..');
const workloads = {
  console: 'browser_console_messages (raw SVG with internal whitespace, first read)',
  scan: 'scan_page (axe)',
} as const;
const commit = z.string().regex(/^[a-f0-9]{7,40}$/);
export const caseSchema = z.strictObject({
  workload: z.enum(['console', 'scan']),
  reference: commit,
  suspect: commit,
  repair: commit.optional(),
});
type Case = z.infer<typeof caseSchema>;
type Role = 'reference' | 'suspect' | 'repair';
type Block = { reference: number, suspect: number, repair?: number };
const samples = z.array(z.number().positive().finite()).length(3);
const blockSchema = z.strictObject({ reference: z.number().positive().finite(), suspect: z.number().positive().finite(), repair: z.number().positive().finite().optional() });

function compare(blocks: Block[], role: Role) {
  const slower = blocks.map(block => {
    const value = block[role];
    if (value === undefined)
      throw new Error('Missing observations for ' + role);
    return value - block.reference > Math.max(10, block.reference * 0.25);
  });
  if (slower.every(Boolean))
    return 'slower';
  return slower.some(Boolean) ? 'mixed' : 'within-budget';
}

// Each observation is the median of a fresh browser process. Never pool calls across launches.
export function decide(input: Block[]) {
  const blocks = z.array(blockSchema).min(3).parse(input);
  const repairs = blocks.filter(block => block.repair !== undefined).length;
  if (repairs !== 0 && repairs !== blocks.length)
    throw new Error('Incomplete recovery comparison');
  const alert = compare(blocks, 'suspect');
  if (alert === 'mixed')
    return 'inconclusive';
  if (alert === 'within-budget')
    return 'no-alert';
  if (!repairs)
    return 'needs-investigation';
  const recovery = compare(blocks, 'repair');
  if (recovery === 'mixed')
    return 'inconclusive';
  return recovery === 'within-budget' ? 'recovery-verified' : 'still-regressed';
}

const next = {
  'needs-investigation': 'Inspect the suspect diff and reproduce one suspected cause. Add a proposed repair SHA to the same case.',
  'still-regressed': 'Reopen the investigation. The proposed repair missed the reference budget.',
  'inconclusive': 'Review the per-launch samples and repeat on a quiet runner before attributing a change.',
  'no-alert': 'Archive this replay. The suspect was within the reference budget in every launch block.',
  'recovery-verified': 'Submit the evidence for human review. Verify the released package separately.',
} satisfies Record<ReturnType<typeof decide>, string>;

function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function build(sha: string, dir: string, worktrees: string[], lockBlob: string) {
  if (git('rev-parse', sha + ':package-lock.json') !== lockBlob)
    throw new Error('Dependency lock differs at ' + sha + '. This pilot compares matching locks only.');
  git('worktree', 'add', '--detach', dir, sha);
  worktrees.push(dir);
  symlinkSync(realpathSync(path.join(root, 'node_modules')), path.join(dir, 'node_modules'), 'junction');
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'], { cwd: dir, stdio: ['ignore', 2, 2] });
}

function measure(dir: string, workload: Case['workload'], output: string, executable: string) {
  const name = workloads[workload];
  execFileSync(process.execPath, [path.join(root, 'bench/mcp-bench.mjs'), '--server', path.join(dir, 'cli.js'),
    '--lib', path.join(dir, 'lib'), '--only', name, '--iterations', '3', '--warmups', '1',
    '--executable-path', executable, '--out', output], { cwd: root, stdio: ['ignore', 2, 2], timeout: 120000 });
  const report = z.object({ scenarios: z.tuple([z.object({ name: z.literal(name), samplesMs: samples })]) }).parse(JSON.parse(readFileSync(output, 'utf8')));
  const values = report.scenarios[0].samplesMs;
  return { medianMs: values.toSorted((a, b) => a - b)[1], samplesMs: values };
}

const withRepair: Role[][] = [['reference', 'suspect', 'repair'], ['suspect', 'repair', 'reference'], ['repair', 'reference', 'suspect']];
const detection: Role[][] = [['reference', 'suspect'], ['suspect', 'reference'], ['suspect', 'reference'], ['reference', 'suspect']];

async function investigate(spec: Case) {
  const executable = process.env.CHROME_HEADLESS_SHELL || chromium.executablePath();
  const browser = await chromium.launch({ executablePath: executable, chromiumSandbox: false });
  const browserVersion = browser.version();
  await browser.close();
  const temp = mkdtempSync(path.join(os.tmpdir(), 'scanner-latency-'));
  const worktrees: string[] = [];
  try {
    const reference = git('rev-parse', '--verify', spec.reference + '^{commit}');
    const suspect = git('rev-parse', '--verify', spec.suspect + '^{commit}');
    const repair = spec.repair && git('rev-parse', '--verify', spec.repair + '^{commit}');
    const revisions = { reference, suspect, repair };
    const lockBlob = git('hash-object', 'package-lock.json');
    for (const sha of new Set([reference, suspect, ...(repair ? [repair] : [])]))
      build(sha, path.join(temp, sha), worktrees, lockBlob);
    const blocks: Block[] = [];
    const launches = [];
    for (const order of repair ? withRepair : detection) {
      const block: Partial<Block> = {};
      for (const role of order) {
        const sha = revisions[role];
        if (!sha)
          throw new Error('Missing revision for ' + role);
        const observation = measure(path.join(temp, sha), spec.workload, path.join(temp, 'run.json'), executable);
        block[role] = observation.medianMs;
        launches.push({ block: blocks.length + 1, role, ...observation });
      }
      blocks.push(blockSchema.parse(block));
    }
    const state = decide(blocks);
    const id = createHash('sha256').update(JSON.stringify([spec.workload, reference, suspect])).digest('hex').slice(0, 16);
    return { id, state, nextAction: next[state], workload: spec.workload, revisions, blocks, launches,
      environment: { node: process.version, browserVersion, platform: process.platform, arch: process.arch,
        cpu: os.cpus()[0].model, lockBlob, harness: git('hash-object', 'bench/mcp-bench.mjs'), fixture: git('hash-object', 'bench/fixture.mjs') } };
  } finally {
    for (const dir of worktrees)
      git('worktree', 'remove', '--force', dir);
    rmSync(temp, { recursive: true, force: true });
  }
}

// Publish only complete runs. Repeated or concurrent attempts keep separate evidence.
function record(caseFile: string, report: Awaited<ReturnType<typeof investigate>>) {
  const directory = path.join(path.dirname(path.resolve(caseFile)), 'latency-cases', report.id);
  mkdirSync(directory, { recursive: true });
  const name = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID() + '.json';
  const target = path.join(directory, name);
  const encoded = JSON.stringify(report, null, 2) + '\n';
  try {
    writeFileSync(target + '.tmp', encoded, { flag: 'wx' });
    renameSync(target + '.tmp', target);
  } finally {
    rmSync(target + '.tmp', { force: true });
  }
  process.stderr.write('Recorded ' + target + '\n');
  process.stdout.write(encoded);
}

if (import.meta.main) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node bench/latency-case.mts case.json');
  const spec = caseSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  record(process.argv[2], await investigate(spec));
}
