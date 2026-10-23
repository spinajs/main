/**
 * After remove-tests.mjs: deletes what only the removed tests used. Repeats until the compiler reports
 * no unused import, const, function or type ( TS6133, TS6196 ) in the package's test files, since
 * dropping one can leave another unused.
 *
 * Usage
 * -----
 *   node scripts/coverage/drop-unused.mjs packages/authz
 */

import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import ts from 'typescript';

const pkgDir = resolve(process.argv[2]);
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
// Package tsconfigs leave test/ out, and ts-node is what refuses an unused local at test time.
const config = join(pkgDir, 'tsconfig.drop-unused.json');
writeFileSync(config, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: true, noUnusedLocals: true }, include: ['src/**/*', 'test/**/*'] }));

try {
  for (let round = 1; ; round++) {
    const out = spawnSync(process.execPath, [TSC, '-p', config], { cwd: pkgDir, encoding: 'utf8' }).stdout;
    const unused = new Map();
    for (const m of out.matchAll(/^(test\/[^(]+)\((\d+),(\d+)\): error TS61(?:33|96): '(.+?)' is declared/gm)) {
      unused.set(m[1], [...(unused.get(m[1]) ?? []), m[4]]);
    }
    if (!unused.size) break;
    if (round > 20) throw new Error('unused declarations keep appearing');
    for (const [file, names] of unused) drop(join(pkgDir, file), new Set(names));
  }
} finally {
  rmSync(config);
}

function drop(file, names) {
  let text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? [...clause.namedBindings.elements] : [];
      const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined;
      const keep = named.filter((e) => !names.has(e.name.text));
      const keepDefault = clause.name && !names.has(clause.name.text) ? clause.name.text : '';
      const keepNamespace = namespace && !names.has(namespace.name.text);
      if (keep.length === named.length && (!clause.name || keepDefault) && (!namespace || keepNamespace)) return;
      if (!keep.length && !keepDefault && !keepNamespace) edits.push([node.getFullStart(), node.getEnd(), '']);
      else edits.push([clause.getStart(), clause.getEnd(), [keepDefault, keepNamespace ? namespace.getText() : '', keep.length ? `{ ${keep.map((e) => e.getText()).join(', ')} }` : ''].filter(Boolean).join(', ')]);
      return;
    }
    if (ts.isVariableStatement(node)) {
      const decls = node.declarationList.declarations;
      if (decls.every((d) => boundNames(d.name).every((n) => names.has(n)))) {
        edits.push([node.getFullStart(), node.getEnd(), '']);
        return;
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name && names.has(node.name.text)) {
      edits.push([node.getFullStart(), node.getEnd(), '']);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  writeFileSync(file, text);
}

function boundNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : boundNames(e.name)));
}
