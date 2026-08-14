import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Publishing metadata is only exercised at release time, so drift here is
// invisible until it reaches a registry. server.json sat at 3.1.0 while
// package.json was already 3.2.0, which publishes an MCP registry entry
// pointing at the wrong npm version.

const rootDir = path.resolve(__dirname, '..');
const readJson = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(rootDir, name), 'utf-8'));

const packageJson = readJson('package.json');
const serverJson = readJson('server.json');

describe('package metadata contract', () => {
  it('keeps the MCP registry manifest on the published package version', () => {
    expect(serverJson.version).toBe(packageJson.version);
    for (const entry of serverJson.packages)
      expect(entry.version, `${entry.identifier} in server.json`).toBe(packageJson.version);
  });

  it('points the registry manifest at the published npm package', () => {
    expect(serverJson.packages.map((p: any) => p.identifier)).toContain(packageJson.name);
    expect(serverJson.name).toBe(packageJson.mcpName);
  });

  it('ships every file the package manifest promises', () => {
    // `files` plus anything named in `bin`, which npm always includes.
    const promised = [
      ...packageJson.files.filter((entry: string) => !entry.includes('*')),
      ...Object.values<string>(packageJson.bin),
    ];
    for (const entry of new Set(promised))
      expect(fs.existsSync(path.join(rootDir, entry)), `${entry} is listed but missing`).toBe(true);
  });

  it('declares every runtime import as a dependency', () => {
    // A runtime import that lives in devDependencies works locally and fails
    // for every consumer of the published package.
    const declared = new Set(Object.keys(packageJson.dependencies));
    const devOnly = new Set(Object.keys(packageJson.devDependencies));
    const sourceFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
          walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
          sourceFiles.push(full);
      }
    };
    walk(path.join(rootDir, 'src'));

    const offenders = new Set<string>();
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
        const specifier = match[1];
        // Relative paths, node: builtins and subpath imports of a declared
        // package are all fine; only a bare package root matters here.
        if (specifier.startsWith('.') || specifier.startsWith('node:'))
          continue;
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!declared.has(pkg) && devOnly.has(pkg))
          offenders.add(`${path.relative(rootDir, file)} imports devDependency "${pkg}"`);
      }
    }
    expect([...offenders]).toEqual([]);
  });

  it('pins the browser-coupled dependencies to exact versions', () => {
    // playwright and axe-core are injected into pages and their behaviour is
    // asserted on; a floating range silently changes audit results.
    for (const pinned of ['playwright', 'playwright-core', 'axe-core'])
      expect(packageJson.dependencies[pinned], pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.dependencies.playwright).toBe(packageJson.dependencies['playwright-core']);
  });
});
