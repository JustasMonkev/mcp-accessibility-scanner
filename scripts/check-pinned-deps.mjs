// Fails when a registry dependency in package.json uses a range instead of an exact version.
// Adapted from earendil-works/pi scripts/check-pinned-deps.mjs (MIT).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set(['.git', 'coverage', 'lib', 'node_modules', 'worktrees']);

const failures = [];
for (const file of collectPackageJsonFiles('.').sort()) {
  const packageJson = JSON.parse(readFileSync(file, 'utf8'));
  for (const section of dependencySections) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (isNonRegistrySpecifier(specifier) || exactVersionPattern.test(versionOf(specifier)))
        continue;
      failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Registry dependencies must use exact versions:');
  for (const failure of failures)
    console.error(`  ${failure}`);
  console.error('Fix: set the version package-lock.json resolved (npm ls <name>), then run');
  console.error('  npm install --package-lock-only --ignore-scripts');
  process.exit(1);
}
console.log('Registry dependencies are pinned.');

function collectPackageJsonFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name))
      files.push(...collectPackageJsonFiles(join(directory, entry.name)));
    else if (entry.isFile() && entry.name === 'package.json')
      files.push(join(directory, entry.name));
  }
  return files;
}

function isNonRegistrySpecifier(specifier) {
  return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:)/.test(specifier);
}

// `npm:name@1.2.3` aliases carry their version after the last `@`.
function versionOf(specifier) {
  if (!specifier.startsWith('npm:'))
    return specifier;
  const target = specifier.slice('npm:'.length);
  const separator = target.lastIndexOf('@');
  return separator <= 0 ? specifier : target.slice(separator + 1);
}
