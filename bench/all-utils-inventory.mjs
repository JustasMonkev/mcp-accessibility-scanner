import { Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Parse the actual build. Extra exports exist only inside the benchmark process.
export function inspectModule(file) {
  const source = readFileSync(file, 'utf8');
  const declarations = [];
  const targets = [];
  const callbacks = [];
  const linter = new Linter();
  const functionNodes = 'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression';
  const inventory = {
    create(context) {
      return {
        ClassDeclaration(node) {
          if (node.parent.type === 'Program' || node.parent.type === 'ExportNamedDeclaration')
            declarations.push(node.id.name);
        },
        [functionNodes](node) {
          const parent = node.parent;
          if (node.type === 'FunctionDeclaration' && (parent.type === 'Program' || parent.type === 'ExportNamedDeclaration')) {
            declarations.push(node.id.name);
            targets.push(node.id.name);
            return;
          }
          if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') {
            targets.push(parent.parent.parent.id.name + '.' + parent.key.name);
            return;
          }
          const outer = context.sourceCode.getAncestors(node).find(ancestor => ancestor.type === 'FunctionDeclaration' || ancestor.type === 'ClassDeclaration');
          const label = parent.id?.name ?? parent.key?.name ?? node.id?.name ?? 'callback';
          const id = (outer?.id?.name ?? 'module') + '/' + label + '@' + node.loc.start.line + ':' + (node.loc.start.column + 1);
          const block = node.body.type === 'BlockStatement';
          const start = block ? node.body.range[0] + 1 : context.sourceCode.getTokens(node).find(token => token.value === '=>').range[1];
          const end = block ? node.body.range[1] - 1 : node.range[1];
          let lifecycle;
          if (basename(file) === 'cdpConnection.js') {
            if (parent.type === 'AssignmentExpression' && parent.left.property?.name === 'onclose')
              lifecycle = parent.left.object.name + '.onclose';
            if (parent.type === 'CallExpression' && parent.callee.name === 'createServer')
              lifecycle = 'http.request';
            if (parent.type === 'CallExpression' && parent.callee.property?.name === 'on' && parent.arguments[0]?.value === 'error')
              lifecycle = parent.callee.object.name + '.error';
          }
          callbacks.push({ id, block, start, end, range: node.range, lifecycle });
        },
      };
    },
  };
  const diagnostics = linter.verify(source, [{ plugins: { bench: { rules: { inventory } } }, rules: { 'bench/inventory': 'error' } }]);
  if (diagnostics.length)
    throw new Error(JSON.stringify(diagnostics));
  return { declarations, targets, callbacks };
}

export function exposeInternals(files, profile) {
  return registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith('file:'))
        return result;
      const file = fileURLToPath(url);
      const inventory = files.get(file);
      if (!inventory)
        return result;
      let source = String(result.source);
      if (profile) {
        const edits = [];
        for (const { id, block, start, end, range, lifecycle } of inventory.callbacks) {
          const key = JSON.stringify(file + '#' + id);
          if (lifecycle) {
            edits.push([range[0], 'globalThis.__captureUtilsCallback(' + key + ',' + JSON.stringify(lifecycle) + ',']);
            edits.push([range[1], ')']);
          }
          edits.push([start, (block ? '' : '{') + 'const __benchStart = performance.now(); try {' + (block ? '' : 'return (')]);
          edits.push([end, (block ? '' : ');') + '} finally {globalThis.__recordUtilsTime(' + key + ', performance.now()-__benchStart);}' + (block ? '' : '}')]);
        }
        // Stable ordering also preserves empty callback blocks.
        for (const [position, insertion] of edits.reverse().sort((a, b) => b[0] - a[0]))
          source = source.slice(0, position) + insertion + source.slice(position);
      }
      return { ...result, source: source + '\nexport const __benchPrivate = {' + inventory.declarations.join(',') + '};\n' };
    },
  });
}
