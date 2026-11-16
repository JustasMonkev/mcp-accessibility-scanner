// Pre-commit guard: blocks a staged package-lock.json change unless the committer opts in with
// ALLOW_LOCKFILE_CHANGE=1, after reviewing what changed.
// Adapted from earendil-works/pi scripts/check-lockfile-commit.mjs (MIT).
import { execFileSync } from 'node:child_process';

const staged = git(['diff', '--cached', '--name-only']).split('\n').map(line => line.trim());
if (!staged.includes('package-lock.json'))
  process.exit(0);
if (['1', 'true', 'yes'].includes(process.env.ALLOW_LOCKFILE_CHANGE ?? '')) {
  console.error('package-lock.json is staged; ALLOW_LOCKFILE_CHANGE is set, allowing the commit.');
  process.exit(0);
}

console.error('package-lock.json is staged. Review it before committing:');
console.error('  - every added or updated package is intentional');
console.error('  - no new install scripts appear in the dependency tree');
console.error('  - playwright and playwright-core stay on the same exact version');
const changes = summarizeChanges(readLock('HEAD:package-lock.json'), readLock(':package-lock.json'));
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
