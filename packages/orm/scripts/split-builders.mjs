#!/usr/bin/env node
/**
 * Splits packages/orm/src/builders.ts into packages/orm/src/builders/*.ts and turns builders.ts
 * into a barrel. Every top-level statement is copied verbatim with its leading comments; only
 * the import declarations are generated, from the identifiers each file uses.
 *
 *   node packages/orm/scripts/split-builders.mjs                 split the working-tree builders.ts
 *   node packages/orm/scripts/split-builders.mjs --from <ref>    split builders.ts as it is at a git ref
 *   node packages/orm/scripts/split-builders.mjs --from <ref> --check
 *                                                                exit 1 when the files on disk differ
 *
 * Exit codes: 0 ok, 1 check failed or the split is unsafe, 2 usage error.
 */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'src/builders.ts';

// The barrel re-exports in this order, and ESM evaluates in it: assertEvaluationOrder() proves
// that no class is extended or passed to a decorator before its module has run.
export const PLACEMENT = [
  ['raw', ['RawQuery']],
  ['base', ['sortQueryMiddlewares', 'Builder', 'QueryBuilder']],
  ['limit', ['LimitBuilder']],
  ['order-by', ['sortOrderOf', 'OrderByBuilder']],
  ['columns', ['ColumnsBuilder']],
  ['group-by', ['GroupByBuilder']],
  ['join', ['JoinBuilder']],
  ['with-recursive', ['WithRecursiveBuilder']],
  ['select', ['BooleanColumnMiddleware', 'SelectQueryBuilder', 'SelectQueryBuilderC']],
  ['where', ['isWhereOperator', 'WhereBuilder', 'queryOf', 'qualifierOf', 'outerBuilder']],
  ['delete', ['DeleteQueryBuilder']],
  ['on-duplicate', ['OnDuplicateQueryBuilder']],
  ['update', ['UpdateQueryBuilder']],
  ['insert', ['mergeInsertResults', 'InsertQueryBuilder']],
  ['schema/index-builder', ['IndexQueryBuilder']],
  ['schema/foreign-key', ['ForeignKeyBuilder']],
  ['schema/column', ['EXACT_TYPES', 'ColumnQueryBuilder', 'AlterColumnQueryBuilder']],
  ['schema/table', ['TableExistsQueryBuilder', 'DropTableQueryBuilder', 'AlterTableQueryBuilder', 'TableQueryBuilder', 'TruncateTableQueryBuilder', 'CloneTableQueryBuilder']],
  ['schema/view', ['DropViewQueryBuilder', 'ViewAlgorithm', 'ViewSecurity', 'ViewCheckOption', 'VIEW_ALGORITHMS', 'VIEW_SECURITY', 'VIEW_CHECK_OPTIONS', 'CreateViewQueryBuilder']],
  ['schema/database', ['CreateDatabaseQueryBuilder', 'DropDatabaseQueryBuilder']],
  ['schema/event', ['EventIntervalUnit', 'EVENT_INTERVAL_UNITS', 'IEventInterval', 'eventInterval', 'EventQueryBuilder', 'DropEventQueryBuilder']],
  ['schema/schema', ['SchemaQueryBuilder', 'RawSchemaQueryBuilder']],
  ['create-query', ['_descriptor', 'createQuery']],
];

// Module-private helpers that several files need. They get `export` in builders/internal.ts,
// which the barrel leaves out, so the package's public exports do not change.
export const INTERNAL = ['IRelationSort', 'assertNarrowed', 'assertOneOf'];

// Top-level statements that declare no name, placed by a pattern over their text.
export const EXPRESSIONS = [[/\b(Alter)?TableQueryBuilder\.prototype\b/, 'schema/table']];

const problems = [];

function fail(message, code = 1) {
  console.error(`split-builders: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { from: undefined, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && argv[i + 1]) args.from = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else fail(`unknown or incomplete argument ${argv[i]}`, 2);
  }
  return args;
}

// Windows checkouts with core.autocrlf hold CRLF; output and comparisons are LF, which git stores anyway.
function lf(text) {
  return text.replace(/\r\n/g, '\n');
}

function readSource(from) {
  if (from === undefined) return lf(readFileSync(join(PKG, SOURCE), 'utf8'));
  const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: PKG, encoding: 'utf8' }).trim();
  return lf(execFileSync('git', ['show', `${from}:${posix.join(prefix, SOURCE)}`], { cwd: PKG, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** A one-file program: enough for the binder to tell which declaration an identifier refers to. */
function bind(text) {
  const fileName = '/builders.ts';
  const options = { noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.ES2021, experimentalDecorators: true };
  const host = {
    getSourceFile: (f) => (f === fileName ? ts.createSourceFile(f, text, ts.ScriptTarget.ES2021, true) : undefined),
    writeFile: () => undefined,
    getDefaultLibFileName: () => '/lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (f) => f === fileName,
    readFile: (f) => (f === fileName ? text : undefined),
  };
  const program = ts.createProgram([fileName], options, host);
  return { sf: program.getSourceFile(fileName), checker: program.getTypeChecker() };
}

function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name.getText());
  return statement.name ? [statement.name.text] : [];
}

function isExported(statement) {
  return (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0;
}

function topLevelStatementOf(node) {
  let n = node;
  while (n.parent && !ts.isSourceFile(n.parent)) n = n.parent;
  return n.parent ? n : undefined;
}

/**
 * True when the identifier only names a type, so TypeScript erases the reference from the output.
 * Used by the evaluation replay only (a type reference runs no code); every generated local import
 * is a plain import regardless (see the notes below the script).
 */
function inTypePosition(id) {
  for (let n = id; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isExpressionWithTypeArguments(p) && p.expression === n) {
      const clause = p.parent;
      return !(ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(clause.parent));
    }
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
  }
  return false;
}

function hasDecorators(node) {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

/**
 * emitDecoratorMetadata reads a type annotation at class definition: the plain type reference of a
 * constructor parameter of a decorated class (or one with a decorated parameter), or of a decorated
 * member, is a runtime reference even though it sits in a type position.
 */
function emittedAsMetadata(id) {
  const ref = id.parent;
  if (!ts.isTypeReferenceNode(ref) || ref.typeName !== id) return false;
  const owner = ref.parent;
  if (owner.type !== ref) return false;
  if (ts.isParameter(owner)) {
    const fn = owner.parent;
    if (ts.isConstructorDeclaration(fn)) return hasDecorators(fn.parent) || fn.parameters.some(hasDecorators);
    return ts.isClassElement(fn) && hasDecorators(fn);
  }
  return (ts.isPropertyDeclaration(owner) || ts.isMethodDeclaration(owner) || ts.isAccessor(owner)) && hasDecorators(owner);
}

/** True when a value reference runs while the module evaluates: heritage, decorators, top-level code. */
function evaluatedEagerly(id) {
  for (let n = id; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isFunctionLike(p) && p.body === n) return false;
    if (ts.isParameter(p) && p.initializer === n) return false;
    if (ts.isPropertyDeclaration(p) && p.initializer === n && (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Static) === 0) return false;
  }
  return true;
}

function referencedDeclarations(checker, id) {
  const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
  return symbol?.declarations ?? [];
}

function forEachIdentifier(node, visit) {
  if (ts.isIdentifier(node)) visit(node);
  ts.forEachChild(node, (child) => forEachIdentifier(child, visit));
}

function readImports(statement, imports) {
  const module = statement.moduleSpecifier.text;
  const clause = statement.importClause;
  if (!clause) return fail(`the side-effect import of ${module} has no owner file`);
  const add = (local, imported, kind, typeOnly) => imports.set(local, { module, imported, kind, typeOnly, order: imports.size });
  if (clause.name) add(clause.name.text, 'default', 'default', clause.isTypeOnly);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) add(bindings.name.text, '*', 'namespace', clause.isTypeOnly);
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) add(el.name.text, (el.propertyName ?? el.name).text, 'named', clause.isTypeOnly || el.isTypeOnly);
  }
}

function placementOf(statement, names, sf, fileOfName) {
  const line = sf.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
  if (names.length === 0) {
    const rule = EXPRESSIONS.find(([pattern]) => pattern.test(statement.getText()));
    if (!rule) fail(`no EXPRESSIONS rule for the statement at line ${line}`);
    return rule[1];
  }
  const files = new Set(names.map((n) => fileOfName.get(n)));
  if (files.has(undefined)) fail(`no PLACEMENT entry for ${names.join(', ')} (line ${line})`);
  if (files.size > 1) fail(`${names.join(', ')} are declared in one statement but placed in different files`);
  return [...files][0];
}

function analyze(text) {
  const { sf, checker } = bind(text);
  const imports = new Map();
  const fileOfName = new Map(PLACEMENT.flatMap(([file, names]) => names.map((n) => [n, file])));
  for (const name of INTERNAL) fileOfName.set(name, 'internal');

  const placed = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      readImports(statement, imports);
      continue;
    }
    const names = declaredNames(statement);
    const typeOnly = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
    placed.push({ statement, names, typeOnly, file: placementOf(statement, names, sf, fileOfName), exported: isExported(statement) });
  }

  const ownerOf = new Map(placed.map((p) => [p.statement, p]));
  for (const p of placed) {
    p.importsUsed = new Set();
    p.localsUsed = new Map();
    forEachIdentifier(p.statement, (id) => {
      const decls = referencedDeclarations(checker, id);
      // 'type' references are erased by the emit: they neither evaluate a module nor run at definition.
      const position = inTypePosition(id) && !emittedAsMetadata(id) ? 'type' : 'value';
      if (decls.some((d) => ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d))) {
        p.importsUsed.add(id.text);
        return;
      }
      for (const decl of decls) {
        const owner = ownerOf.get(topLevelStatementOf(decl));
        if (!owner || owner.file === p.file || !owner.names.includes(id.text)) continue;
        const use = p.localsUsed.get(owner.file) ?? { names: new Map(), eager: new Set() };
        const kind = owner.typeOnly ? 'type' : position;
        if (use.names.get(id.text) !== 'value') use.names.set(id.text, kind);
        if (kind === 'value' && evaluatedEagerly(id)) use.eager.add(id.text);
        p.localsUsed.set(owner.file, use);
        if (!owner.exported && owner.file !== 'internal') problems.push(`${p.file} uses ${id.text}, which ${owner.file} does not export`);
      }
    });
  }
  return { sf, imports, placed };
}

function relativeTo(fromFile, target) {
  const rel = posix.relative(posix.dirname(posix.join('src/builders', fromFile)), target);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function importLine(module, group) {
  const kw = group.typeOnly ? 'import type' : 'import';
  if (group.namespaceName) return `${kw} * as ${group.namespaceName} from '${module}';`;
  const parts = [group.defaultName, group.named.length > 0 ? `{ ${group.named.join(', ')} }` : undefined].filter(Boolean);
  return `${kw} ${parts.join(', ')} from '${module}';`;
}

// External imports keep the form the original declaration had (`import type` stays `import type`).
function externalImportLines(file, entries, imports) {
  const used = new Set();
  for (const p of entries) for (const name of p.importsUsed) used.add(name);
  const groups = new Map();
  for (const name of [...used].sort((a, b) => imports.get(a).order - imports.get(b).order)) {
    const imp = imports.get(name);
    const key = `${imp.module} ${imp.typeOnly}`;
    const group = groups.get(key) ?? { module: imp.module, typeOnly: imp.typeOnly, named: [] };
    if (imp.kind === 'default') group.defaultName = name;
    else if (imp.kind === 'namespace') group.namespaceName = name;
    else group.named.push(imp.imported === name ? name : `${imp.imported} as ${name}`);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => importLine(g.module.startsWith('.') ? relativeTo(file, posix.join('src', g.module)) : g.module, g));
}

function localImportLines(file, entries, fileOrder) {
  const merged = new Map();
  const needs = [];
  for (const p of entries) {
    for (const [target, use] of p.localsUsed) {
      const slot = merged.get(target) ?? new Map();
      for (const [name, kind] of use.names) if (slot.get(name) !== 'value') slot.set(name, kind);
      merged.set(target, slot);
      for (const name of use.eager) needs.push({ file: target, name });
    }
  }
  const lines = [];
  const deps = [];
  for (const target of fileOrder.filter((f) => merged.has(f))) {
    const names = merged.get(target);
    // Always a plain import; TypeScript drops it from the emit when no binding is used as a value.
    lines.push(importLine(relativeTo(file, `src/builders/${target}.js`), { named: [...names.keys()] }));
    // ESM evaluates the target only through an import that survives the emit.
    if ([...names.values()].includes('value')) deps.push(target);
  }
  return { lines, deps, needs };
}

function statementText(sf, p) {
  const leading = sf.text.slice(p.statement.getFullStart(), p.statement.getStart()).replace(/^\s*\n/, '');
  const own = sf.text.slice(p.statement.getStart(), p.statement.getEnd());
  return p.file === 'internal' && !p.exported ? `${leading}export ${own}` : `${leading}${own}`;
}

function render({ sf, imports, placed }) {
  // internal comes first in import order: it imports no other builders file.
  const fileOrder = ['internal', ...PLACEMENT.map(([file]) => file)];
  const output = new Map();
  const valueDeps = new Map();
  const eagerNeeds = new Map();

  for (const file of fileOrder) {
    const entries = placed.filter((p) => p.file === file);
    if (entries.length === 0) fail(`${file} received no statement`);
    const local = localImportLines(file, entries, fileOrder);
    valueDeps.set(file, local.deps);
    eagerNeeds.set(file, local.needs);
    const header = [...externalImportLines(file, entries, imports), ...local.lines].join('\n');
    const body = entries.map((p) => statementText(sf, p)).join('\n\n');
    output.set(`src/builders/${file}.ts`, `${header}\n\n${body.trim()}\n`);
  }

  assertEvaluationOrder(PLACEMENT.map(([file]) => file), valueDeps, eagerNeeds);
  assertSameExports(sf, placed);
  if (problems.length > 0) fail(`unsafe split:\n  ${[...new Set(problems)].join('\n  ')}`);

  output.set(SOURCE, `${PLACEMENT.map(([file]) => `export * from './builders/${file}.js';`).join('\n')}\n`);
  return output;
}

/** Replays ESM evaluation from the barrel: a class must not be extended or decorated with before its module ran. */
function assertEvaluationOrder(barrelOrder, valueDeps, eagerNeeds) {
  const state = new Map();
  const visit = (file) => {
    if (state.has(file)) return;
    state.set(file, 'evaluating');
    for (const dep of valueDeps.get(file)) visit(dep);
    for (const need of eagerNeeds.get(file)) {
      if (state.get(need.file) !== 'done') problems.push(`${file} needs ${need.name} from ${need.file} before ${need.file} has run; reorder PLACEMENT`);
    }
    state.set(file, 'done');
  };
  for (const file of barrelOrder) visit(file);
}

function assertSameExports(sf, placed) {
  const before = sf.statements.filter((s) => !ts.isImportDeclaration(s) && isExported(s)).flatMap(declaredNames);
  const after = new Set(placed.filter((p) => p.exported && p.file !== 'internal').flatMap((p) => p.names));
  for (const name of before) if (!after.has(name)) problems.push(`export ${name} is no longer reachable from the barrel`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = readSource(args.from);
  if (!/^export class /m.test(text)) fail('builders.ts declares no class: it is already split; pass --from <ref>', 2);
  const output = render(analyze(text));

  let stale = 0;
  for (const [rel, content] of output) {
    const target = join(PKG, rel);
    if (!args.check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    } else if (!existsSync(target) || lf(readFileSync(target, 'utf8')) !== content) {
      console.error(`differs: ${rel}`);
      stale++;
    }
  }
  if (stale > 0) process.exit(1);
  console.log(`split-builders: ${output.size} files ${args.check ? 'match' : 'written'}`);
}

main();
