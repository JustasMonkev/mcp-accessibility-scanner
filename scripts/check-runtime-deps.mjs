// Fails when src/ imports a package at runtime that package.json does not list in dependencies.
// npm installs only `dependencies` for users, so such an import breaks the published package.
// Adapted from earendil-works/pi scripts/check-runtime-deps.mjs (MIT).
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { relative, resolve } from 'node:path';
import { listImports } from './sourceImports.mjs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = new Set([
  manifest.name,
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

const { imports, strayFiles } = listImports(resolve('tsconfig.json'));
const failures = strayFiles.map(file => `${relative('.', file)} is outside tsconfig.json's include but imported by the build`);
for (const { file, line, specifier, typeOnly } of imports) {
  if (typeOnly || specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier))
    continue;
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  if (declared.has(name))
    continue;
  const where = manifest.devDependencies?.[name] ? 'is only a devDependency' : 'is not declared';
  failures.push(`${relative('.', file)}:${line}: ${specifier} ${where}. Move it to dependencies, or make the import type-only.`);
}

if (failures.length > 0) {
  console.error(`Runtime imports that ${manifest.name} users would not have installed:`);
  for (const failure of failures)
    console.error(`  ${failure}`);
  process.exit(1);
}
console.log('Runtime imports have declared dependencies.');
