#!/usr/bin/env node
/**
 * Marks the imports TypeScript erases as `import type`, so that dependency-cruiser, whose no-circular
 * rule skips declared type-only edges only, sees the same module graph as the emitted JavaScript. A binding is erased
 * when the emitted file does not import it; decorator metadata is accounted for because it is
 * part of the emit. The script emits every file again after the rewrite and fails unless the
 * JavaScript is byte-identical.
 *
 *   node scripts/type-only-imports.mjs <package-dir> [--check] [--tsconfig <file>]
 *
 * Exit codes: 0 ok (or nothing to change), 1 --check found imports to rewrite or the emit changed,
 * 2 usage error.
 */
import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const args = { dir: undefined, check: false, tsconfig: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--tsconfig' && argv[i + 1]) args.tsconfig = argv[++i];
    else if (!argv[i].startsWith('--') && args.dir === undefined) args.dir = resolve(argv[i]);
    else usage(`unknown argument ${argv[i]}`);
  }
  if (!args.dir) usage('missing <package-dir>');
  args.tsconfig = resolve(args.tsconfig ?? join(args.dir, 'tsconfig.build.json'));
  return args;
}

function usage(message) {
  console.error(`type-only-imports: ${message}\nusage: node scripts/type-only-imports.mjs <package-dir> [--check] [--tsconfig <file>]`);
  process.exit(2);
}

function readConfig(tsconfig) {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, { noEmit: false }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => usage(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
  return { fileNames: parsed.fileNames.filter((f) => !f.endsWith('.d.ts')), options: { ...parsed.options, noEmit: false, declaration: false, declarationMap: false, sourceMap: false, composite: false, incremental: false } };
}

/** Emits every root file to memory; returns fileName -> JavaScript text. */
function emitAll(fileNames, options, overrides = new Map()) {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, create) => {
    const text = overrides.get(resolve(fileName));
    return text === undefined ? getSourceFile(fileName, languageVersion, onError, create) : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram(fileNames, options, host);
  const out = new Map();
  for (const fileName of fileNames) {
    const sf = program.getSourceFile(fileName);
    program.emit(sf, (name, text) => {
      if (name.endsWith('.js')) out.set(resolve(fileName), text);
    });
  }
  return { program, out };
}

/** module specifier -> local names the emitted JavaScript still imports. */
function keptBindings(js) {
  const kept = new Map();
  const sf = ts.createSourceFile('out.js', js, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const names = kept.get(st.moduleSpecifier.text) ?? new Set();
    const clause = st.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) names.add(el.name.text);
    kept.set(st.moduleSpecifier.text, names);
  }
  return kept;
}

function specifierText(el) {
  return el.propertyName ? `${el.propertyName.text} as ${el.name.text}` : el.name.text;
}

/** Returns the replacement text for an import declaration, or undefined when it stays as it is. */
function rewriteImport(st, kept, sf, eol) {
  const clause = st.importClause;
  if (!clause || clause.isTypeOnly) return undefined;
  const module = st.moduleSpecifier.getText(sf);
  const keep = kept.get(st.moduleSpecifier.text) ?? new Set();
  const defaultKept = clause.name ? keep.has(clause.name.text) : undefined;
  const bindings = clause.namedBindings;

  if (bindings && ts.isNamespaceImport(bindings)) {
    return keep.has(bindings.name.text) || defaultKept ? undefined : `import type * as ${bindings.name.text} from ${module};`;
  }

  const named = bindings ? bindings.elements.filter((el) => !el.isTypeOnly) : [];
  const valueNamed = named.filter((el) => keep.has(el.name.text));
  const typeNamed = named.filter((el) => !keep.has(el.name.text));
  const inlineTypes = bindings ? bindings.elements.filter((el) => el.isTypeOnly) : [];
  if (typeNamed.length === 0 && defaultKept !== false) return undefined;

  const lines = [];
  const valueParts = [];
  if (defaultKept) valueParts.push(clause.name.text);
  if (valueNamed.length > 0) valueParts.push(`{ ${valueNamed.map(specifierText).join(', ')} }`);
  if (valueParts.length > 0) lines.push(`import ${valueParts.join(', ')} from ${module};`);
  if (defaultKept === false) lines.push(`import type ${clause.name.text} from ${module};`);
  const types = [...typeNamed.map(specifierText), ...inlineTypes.map(specifierText)];
  if (types.length > 0) lines.push(`import type { ${types.join(', ')} } from ${module};`);
  return lines.join(eol);
}

function rewriteFile(sf, js) {
  const kept = keptBindings(js);
  const eol = sf.text.includes('\r\n') ? '\r\n' : '\n';
  const edits = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const replacement = rewriteImport(st, kept, sf, eol);
    if (replacement !== undefined) edits.push({ start: st.getStart(sf), end: st.getEnd(), replacement });
  }
  let text = sf.text;
  for (const e of edits.reverse()) text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
  return { text, count: edits.length };
}

function firstDifference(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const i = left.findIndex((line, n) => line !== right[n]);
  return `line ${i + 1}: ${JSON.stringify(left[i])} became ${JSON.stringify(right[i])}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { fileNames, options } = readConfig(args.tsconfig);
  const before = emitAll(fileNames, options);

  const changed = new Map();
  let total = 0;
  for (const fileName of fileNames) {
    const key = resolve(fileName);
    const js = before.out.get(key);
    if (js === undefined) continue;
    const { text, count } = rewriteFile(before.program.getSourceFile(fileName), js);
    if (count > 0) {
      changed.set(key, text);
      total += count;
      console.log(`${count}\t${fileName}`);
    }
  }

  const after = emitAll(fileNames, options, changed);
  const drift = [...before.out.keys()].filter((k) => before.out.get(k) !== after.out.get(k));
  if (drift.length > 0) {
    console.error('type-only-imports: the emitted JavaScript changed, nothing written');
    for (const k of drift) console.error(`  ${k}\n    first difference: ${firstDifference(before.out.get(k), after.out.get(k) ?? '')}`);
    process.exit(1);
  }

  if (args.check) {
    console.log(`type-only-imports: ${total} import declaration(s) to rewrite in ${changed.size} file(s)`);
    process.exit(total > 0 ? 1 : 0);
  }
  for (const [fileName, text] of changed) writeFileSync(fileName, text);
  console.log(`type-only-imports: rewrote ${total} import declaration(s) in ${changed.size} file(s); emit unchanged`);
}

main();
