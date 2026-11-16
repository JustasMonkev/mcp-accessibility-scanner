// Lists the imports of a TypeScript project's source files, using the TypeScript 7 API.
// The type-only rules follow earendil-works/pi scripts/check-runtime-deps.mjs (MIT).
import { isAbsolute, relative, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
} from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/sync';

/**
 * @typedef {{ file: string, line: number, specifier: string, typeOnly: boolean }} SourceImport
 * `file` is absolute. `typeOnly` is true when TypeScript erases the import, so it carries no runtime dependency.
 */

/**
 * Returns every static and dynamic import in the project's own `.ts` files, plus the files the program pulls in
 * from inside the project directory although its `include` leaves them out.
 * @param {string} configPath absolute path of a tsconfig.json
 * @returns {{ imports: SourceImport[], strayFiles: string[] }}
 */
export function listImports(configPath) {
  const projectDirectory = resolve(configPath, '..');
  const api = new API({ cwd: projectDirectory });
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath);
    const diagnostics = project.program.getConfigFileParsingDiagnostics();
    if (diagnostics.length > 0)
      throw new Error(diagnostics.map(diagnostic => diagnostic.text).join('\n'));
    const roots = new Set(project.rootFiles.map(file => resolve(file)));
    const imports = [];
    const strayFiles = [];
    for (const fileName of project.program.getSourceFileNames()) {
      const file = resolve(fileName);
      if (file.endsWith('.d.ts') || file.endsWith('.json') || isOutside(projectDirectory, file))
        continue;
      // `include` only filters roots: an import can pull an excluded file back into the build.
      if (!roots.has(file))
        strayFiles.push(file);
      imports.push(...importsOf(project.program.getSourceFile(fileName), file));
    }
    return { imports, strayFiles };
  } finally {
    api.close();
  }
}

function isOutside(directory, file) {
  const path = relative(directory, file);
  return path.startsWith('..') || isAbsolute(path) || path.split(/[\\/]/).includes('node_modules');
}

function importsOf(source, file) {
  const found = [];
  const add = (node, typeOnly) => {
    if (!node || !(isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)))
      return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file, line: line + 1, specifier: node.text, typeOnly });
  };
  const visit = node => {
    if (isImportDeclaration(node))
      add(node.moduleSpecifier, isTypeOnlyImport(node.importClause));
    else if (isExportDeclaration(node) && node.moduleSpecifier)
      add(node.moduleSpecifier, isTypeOnlyExport(node));
    else if (isCallExpression(node) && (node.expression.kind === SyntaxKind.ImportKeyword || (isIdentifier(node.expression) && node.expression.text === 'require')))
      add(node.arguments[0], false);
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

// `import type { A }` and `import { type A, type B }` are erased; a bare `import 'x'` or any value binding is not.
function isTypeOnlyImport(clause) {
  if (!clause)
    return false;
  if (clause.phaseModifier === SyntaxKind.TypeKeyword)
    return true;
  const bindings = clause.namedBindings;
  return !clause.name && !!bindings && isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
}

function isTypeOnlyExport(node) {
  if (node.isTypeOnly)
    return true;
  const clause = node.exportClause;
  return !!clause && isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
}
