// Enforces the module boundaries written in src/**/DEPS.list (Playwright's utils/check_deps.js format).
//
// A file is governed by the nearest DEPS.list in its directory or an ancestor. `[*]` lists what every governed file
// may import and `[path/from/DEPS.list.ts]` adds entries for one file. An entry is a path relative to the DEPS.list:
// a directory (`../utils/`) allows the files directly in it, `dir/**` allows its whole subtree, a file allows that
// file, and `***` allows anything. Files may always import files in their own directory. Type-only imports are
// exempt: TypeScript erases them. Package imports are checked by check-runtime-deps.mjs, not here.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { listImports } from './sourceImports.mjs';

const sourceRoot = resolve('src');
const depsLists = existsSync(sourceRoot) ? findDepsLists(sourceRoot).map(parseDepsList) : [];
if (depsLists.length === 0) {
  console.log('No DEPS.list under src/: no module boundaries to check.');
  process.exit(0);
}
const rulesByDirectory = new Map(depsLists.map(rules => [rules.directory, rules]));
const failures = depsLists.flatMap(rules => rules.stale.map(entry => `${show(rules.file)}: entry ${entry} matches nothing. Remove it.`));

const { imports } = listImports(resolve('tsconfig.json'));
for (const { file, line, specifier, typeOnly } of imports) {
  if (typeOnly || !specifier.startsWith('.'))
    continue;
  const rules = rulesFor(dirname(file));
  if (!rules)
    continue;
  const target = resolveSourceFile(dirname(file), specifier);
  const fileSection = relative(rules.directory, file).split(sep).join('/');
  const allowed = [...rules.sections.get('*') ?? [], ...rules.sections.get(fileSection) ?? []];
  if (!target || isAllowed(file, target, allowed))
    continue;
  const allowedText = allowed.length ? allowed.map(entry => entry.text).join(', ') : 'its own directory only';
  failures.push(`${show(file)}:${line} imports ${show(target)}; ${show(rules.file)} allows ${allowedText}`);
}

if (failures.length > 0) {
  console.error('Imports that cross module boundaries:');
  for (const failure of failures)
    console.error(`  ${failure}`);
  console.error('Fix: import only types from it (`import type`), or move the shared code into a module this file may');
  console.error('import. Editing DEPS.list changes the architecture: ask first.');
  process.exit(1);
} else {
  console.log('Imports respect src/**/DEPS.list.');
}

// The nearest DEPS.list at or above the directory, within src/.
function rulesFor(directory) {
  for (let current = directory; current === sourceRoot || current.startsWith(sourceRoot + sep); current = dirname(current)) {
    if (rulesByDirectory.has(current))
      return rulesByDirectory.get(current);
  }
  return undefined;
}

function findDepsLists(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory())
      return findDepsLists(join(directory, entry.name));
    return entry.name === 'DEPS.list' ? [join(directory, entry.name)] : [];
  });
}

function parseDepsList(file) {
  const directory = dirname(file);
  const sections = new Map();
  const stale = [];
  let section;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const text = raw.trim();
    if (!text || text.startsWith('#'))
      continue;
    const header = text.match(/^\[(.*)\]$/);
    if (header) {
      section = [];
      sections.set(header[1], section);
      continue;
    }
    if (!section)
      throw new Error(`${show(file)}: entry ${text} comes before any [section]`);
    if (text.startsWith('"') || text.startsWith('node_modules/') || text.startsWith('@'))
      throw new Error(`${show(file)}: ${text} is a Playwright DEPS.list directive this checker does not support`);
    if (text === '***') {
      section.push({ text, kind: 'any' });
      continue;
    }
    const subtree = text.endsWith('**');
    const path = resolve(directory, subtree ? text.slice(0, -2) : text);
    if (!existsSync(path) && !existsSync(path.replace(/\.js$/, '.ts')))
      stale.push(text);
    section.push({ text, kind: subtree ? 'subtree' : existsSync(path) && statSync(path).isDirectory() ? 'directory' : 'file', path: path.replace(/\.js$/, '.ts') });
  }
  return { file, directory, sections, stale };
}

function isAllowed(from, to, entries) {
  if (dirname(from) === dirname(to))
    return true;
  return entries.some(entry => entry.kind === 'any'
    || (entry.kind === 'directory' && dirname(to) === entry.path)
    || (entry.kind === 'subtree' && to.startsWith(entry.path))
    || (entry.kind === 'file' && to === entry.path));
}

// Source imports name the emitted `.js` file; the checked file is the `.ts` beside it, or a directory's index.ts.
function resolveSourceFile(directory, specifier) {
  const path = resolve(directory, specifier);
  for (const candidate of [path.replace(/\.js$/, '.ts'), path, `${path}.ts`, join(path, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile())
      return candidate;
  }
  return undefined;
}

function show(path) {
  return relative('.', path).split(sep).join('/');
}
