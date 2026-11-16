import { execFileSync } from 'node:child_process';

const staged = git(['diff', '--cached', '--name-only']).split('\n').map(line => line.trim());
if (!staged.includes('package-lock.json'))
  process.exit(0);
const before = readLock('HEAD:package-lock.json');
const after = readLock(':package-lock.json');
// Without os/cpu/libc, npm ci installs the wrong native binary (PR #139), so ALLOW_LOCKFILE_CHANGE cannot override this.
const platformLosses = lostPlatformFields(before, after);
if (platformLosses.length > 0) {
  console.error('package-lock.json drops platform fields from native packages:');
  for (const loss of platformLosses.slice(0, 20))
    console.error(`  - ${loss}`);
  console.error('Regenerate it with the npm version CI uses (npm --version in .github/workflows/ci.yml), from a clean');
  console.error('install, so npm keeps the fields. ALLOW_LOCKFILE_CHANGE does not override this.');
  process.exit(1);
}
if (['1', 'true', 'yes'].includes(process.env.ALLOW_LOCKFILE_CHANGE ?? '')) {
  console.error('package-lock.json is staged; ALLOW_LOCKFILE_CHANGE is set, allowing the commit.');
  process.exit(0);
}

console.error('package-lock.json is staged. Review it before committing:');
console.error('  - every added or updated package is intentional');
console.error('  - no new install scripts appear in the dependency tree');
console.error('  - playwright and playwright-core stay on the same exact version');
const changes = summarizeChanges(before, after);
if (changes.length > 0) {
  console.error('\nPackage changes:');
  for (const change of changes.slice(0, 40))
    console.error(`  - ${change}`);
  if (changes.length > 40)
    console.error(`  ... ${changes.length - 40} more`);
}
console.error('\nIf the change is intentional, commit with: ALLOW_LOCKFILE_CHANGE=1 git commit ...');
process.exit(1);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readLock(ref) {
  try {
    return JSON.parse(git(['show', ref])).packages ?? {};
  } catch {
    return {};
  }
}

function lostPlatformFields(before, after) {
  return Object.entries(before).flatMap(([path, entry]) => ['os', 'cpu', 'libc']
      .filter(field => field in entry && after[path] && !(field in after[path]))
      .map(field => `${path} lost "${field}"`));
}

function summarizeChanges(before, after) {
  const changes = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const [old, next] = [before[path], after[path]];
    if (!path.includes('node_modules/') || JSON.stringify(old) === JSON.stringify(next))
      continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!old)
      changes.push(`added ${name}@${next.version}`);
    else if (!next)
      changes.push(`removed ${name}@${old.version}`);
    else if (old.version !== next.version)
      changes.push(`changed ${name} ${old.version} -> ${next.version}`);
    else
      changes.push(`changed ${name}@${next.version} metadata`);
  }
  return changes;
}
