/**
 * Minimal ESM loader: rewrites .js specifiers to .ts when the .ts file exists.
 * Used with: node --import ./tests/ts-loader.mjs --experimental-transform-types
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  // Only remap relative and absolute file imports that end with .js
  if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('/'))) {
    const parentDir = context.parentURL
      ? resolvePath(fileURLToPath(context.parentURL), '..')
      : process.cwd();
    const tsSpecifier = specifier.slice(0, -3) + '.ts';
    const tsPath = resolvePath(parentDir, tsSpecifier);
    if (existsSync(tsPath)) {
      return nextResolve(tsSpecifier, context);
    }
  }
  return nextResolve(specifier, context);
}
