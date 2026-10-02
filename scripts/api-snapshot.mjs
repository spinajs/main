#!/usr/bin/env node
/**
 * API snapshots of the frozen contract entry points (plan §1 rule 3).
 *
 * For every package in scripts/api-snapshot.json this writes
 * packages/<name>/etc/<name>.api.md: the emitted declarations of each file the
 * entries reach through relative imports, with the values of its top-level
 * constants, then the declarations (and constant values) of the symbols the
 * entries re-export from other packages. Comments, formatting and function
 * bodies do not count; any change to a declaration or a constant value does.
 *
 * `--update` and `--check` read the referenced packages' built `.d.ts` (and
 * their declaration maps for constant values), so run them after
 * `npm run build`; CI does. A stale build gives a stale snapshot.
 *
 * Usage:
 *   node scripts/api-snapshot.mjs [--update]   write the snapshots
 *   node scripts/api-snapshot.mjs --check      exit 1 when a snapshot is missing, stale or extra,
 *                                              when a module augmentation targets a snapshotted
 *                                              package or file, or when a file of a frozen
 *                                              pattern is not configured
 *   node scripts/api-snapshot.mjs --check-rfc <base-ref>
 *                                              after gate G1, exit 1 when a snapshot changed
 *                                              in <base-ref>...HEAD without an RFC file
 * Exit codes: 0 ok, 1 violation, 2 tool or environment error.
 *
 * CI runs --check-rfc on pull requests (against the base branch) and on pushes
 * (against the previous head). The integrator, who merges lanes into
 * feat/authz-v3 locally, runs `--check-rfc <previous feat/authz-v3 head>`
 * before pushing a merge.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Loaded lazily so that --check-rfc, which needs only git, also runs without node_modules.
let ts;
try {
  ts = (await import('typescript')).default;
} catch {
  ts = undefined;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RFC_FILE = /^docs\/plans\/authz-v3-rfc\/[A-Za-z0-9]+-\d+\.md$/;
const G1_TAG = 'authz-v3-g1';
const SNAPSHOT_PATH = /^packages\/[^/]+\/etc\/[^/]+\.api\.md$/;
const FROZEN_PACKAGE = /^auth[nz](-|$)/;
const FROZEN_FILES = ['src/contracts.ts', 'src/api.ts', 'src/contracts/index.ts'];

let printerInstance;

function requireTs() {
  if (!ts) throw new Error('the typescript package is not installed; run `npm ci` first');
  printerInstance ??= ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return ts;
}

const toPosix = (p) => p.split(sep).join('/');
const real = (p) => toPosix(realpathSync(p));
const isInside = (dir, file) => file.startsWith(dir + '/') && !file.slice(dir.length).includes('/node_modules/');
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Parsing lib and @types declarations dominates the run; reuse them across the per-package programs.
const declarationCache = new Map();

function createHost(options) {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (!fileName.endsWith('.d.ts') || shouldCreate) return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    const text = host.readFile(fileName);
    if (text === undefined) return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
    const version = typeof languageVersionOrOptions === 'object' ? `${languageVersionOrOptions.languageVersion}/${languageVersionOrOptions.impliedNodeFormat}` : String(languageVersionOrOptions);
    const key = `${fileName}|${version}`;
    const hit = declarationCache.get(key);
    if (hit && hit.text === text) return hit.sf;
    const sf = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    declarationCache.set(key, { text, sf });
    return sf;
  };
  return host;
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => ROOT, getNewLine: () => '\n' });
}

function createProgram(dir, tsconfig, entries) {
  const configPath = join(dir, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(formatDiagnostics([d]));
      },
    },
  );
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
  const options = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    noEmitOnError: false,
    newLine: ts.NewLineKind.LineFeed,
  };
  return ts.createProgram({ rootNames: entries.map((e) => resolve(dir, e)), options, host: createHost(options), projectReferences: parsed.projectReferences });
}

function moduleFileOf(checker, specifier) {
  const symbol = checker.getSymbolAtLocation(specifier);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return decl && ts.isSourceFile(decl) ? decl : undefined;
}

// Files the entries reach through relative module specifiers that stay inside the package.
function closureOf(program, pkgDir, entryFiles) {
  const checker = program.getTypeChecker();
  const seen = new Map();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const sf = queue.shift();
    const path = real(sf.fileName);
    if (seen.has(path)) continue;
    seen.set(path, sf);
    const visit = (node) => {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal;
      else if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) specifier = node.expression;
      if (specifier && specifier.text.startsWith('.')) {
        const target = moduleFileOf(checker, specifier);
        if (target && isInside(pkgDir, real(target.fileName))) queue.push(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...seen.entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([path, sf]) => ({ path, sf }));
}

// Makes the printed text depend on the code alone. The referenced packages' .d.ts come
// from TypeScript 7 and keep the source quotes, this compiler's emit does not, so every
// string literal is printed fresh. Object and array literals drop the source's line
// breaks and trailing commas, and function bodies inside constant values are emptied.
function canonical(ctx) {
  const f = ts.factory;
  const empty = (body) => body && f.createBlock([]);
  const visit = (node) => {
    if (ts.isStringLiteral(node)) return f.createStringLiteral(node.text);
    const n = ts.visitEachChild(node, visit, ctx);
    if (ts.isObjectLiteralExpression(n)) return f.createObjectLiteralExpression([...n.properties], true);
    if (ts.isArrayLiteralExpression(n)) return f.createArrayLiteralExpression([...n.elements], true);
    if (ts.isArrowFunction(n)) return f.updateArrowFunction(n, n.modifiers, n.typeParameters, n.parameters, n.type, n.equalsGreaterThanToken, f.createBlock([]));
    if (ts.isFunctionExpression(n)) return f.updateFunctionExpression(n, n.modifiers, n.asteriskToken, n.name, n.typeParameters, n.parameters, n.type, f.createBlock([]));
    if (ts.isFunctionDeclaration(n)) return f.updateFunctionDeclaration(n, n.modifiers, n.asteriskToken, n.name, n.typeParameters, n.parameters, n.type, empty(n.body));
    if (ts.isMethodDeclaration(n)) return f.updateMethodDeclaration(n, n.modifiers, n.asteriskToken, n.name, n.questionToken, n.typeParameters, n.parameters, n.type, empty(n.body));
    if (ts.isGetAccessorDeclaration(n)) return f.updateGetAccessorDeclaration(n, n.modifiers, n.name, n.parameters, n.type, empty(n.body));
    if (ts.isSetAccessorDeclaration(n)) return f.updateSetAccessorDeclaration(n, n.modifiers, n.name, n.parameters, empty(n.body));
    if (ts.isConstructorDeclaration(n)) return f.updateConstructorDeclaration(n, n.modifiers, n.parameters, empty(n.body));
    if (ts.isClassStaticBlockDeclaration(n)) return f.updateClassStaticBlockDeclaration(n, f.createBlock([]));
    return n;
  };
  return (root) => ts.visitNode(root, visit);
}

// Without a source file the printer cannot copy the source's line breaks or literal text.
function print(node) {
  const result = ts.transform(node, [canonical]);
  try {
    const out = result.transformed[0];
    return (ts.isSourceFile(out) ? printerInstance.printFile(out) : printerInstance.printNode(ts.EmitHint.Unspecified, out, undefined)).trim();
  } finally {
    result.dispose();
  }
}

function reprint(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return print(sf);
}

function declarationText(program, sf) {
  if (sf.isDeclarationFile) return reprint(sf.fileName, sf.text);
  let out;
  const result = program.emit(
    sf,
    (name, text) => {
      if (/\.d\.[cm]?ts$/.test(name)) out = text;
    },
    undefined,
    true,
  );
  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(formatDiagnostics(errors));
  if (out === undefined) throw new Error(`no declaration output for ${sf.fileName}`);
  return reprint(sf.fileName, out);
}

function isFunctionValue(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e);
}

/** Top-level `const` declarations of a source file whose value is not a function or class, by name, in source order. */
function constantsOf(sf) {
  const out = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of stmt.declarationList.declarations) if (d.initializer && !isFunctionValue(d.initializer)) out.set(d.name.getText(sf), d);
  }
  return out;
}

const valueLine = (decl, sf) => `const ${decl.name.getText(sf)} = ${print(decl.initializer)};`;

function valuesSection(sf) {
  if (sf.isDeclarationFile) return '';
  const lines = [...constantsOf(sf).values()].map((d) => valueLine(d, sf));
  return lines.length > 0 ? `\n\n// values\n${lines.join('\n')}` : '';
}

const sourceFiles = new Map();

// The source a built .d.ts came from, through its declaration map.
function sourceOfDeclarationFile(dtsFileName) {
  if (sourceFiles.has(dtsFileName)) return sourceFiles.get(dtsFileName);
  let sf;
  const mapPath = `${dtsFileName}.map`;
  if (existsSync(mapPath)) {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const src = map.sources?.[0] && resolve(dirname(mapPath), map.sourceRoot ?? '', map.sources[0]);
    if (src && existsSync(src)) sf = ts.createSourceFile(src, readFileSync(src, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  }
  sourceFiles.set(dtsFileName, sf);
  return sf;
}

// `name`'s value plus the values of the other top-level constants it names, transitively.
function constantWithDependencies(sf, name) {
  const constants = constantsOf(sf);
  const found = new Map();
  const add = (n) => {
    const decl = constants.get(n);
    if (!decl || found.has(n)) return;
    found.set(n, decl);
    const visit = (node) => {
      if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(decl.initializer);
  };
  add(name);
  return [...found.values()].map((d) => valueLine(d, sf));
}

function externalValue(decl, name) {
  if (!ts.isVariableDeclaration(decl)) return '';
  const own = decl.getSourceFile();
  const sf = own.isDeclarationFile ? sourceOfDeclarationFile(own.fileName) : own;
  if (!sf) return '\n// value: unknown (no declaration map next to the .d.ts)';
  const lines = constantWithDependencies(sf, name);
  return lines.length > 0 ? `\n// value\n${lines.join('\n')}` : '';
}

const packageNames = new Map();

function packageNameOf(fileName) {
  let dir = dirname(fileName);
  for (;;) {
    if (packageNames.has(dir)) return packageNames.get(dir);
    const manifest = join(dir, 'package.json');
    // lib/mjs and lib/cjs carry a nameless package.json that only sets the module type.
    const name = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).name : undefined;
    if (name) {
      packageNames.set(dir, name);
      return name;
    }
    const parent = dirname(dir);
    if (parent === dir) return '?';
    dir = parent;
  }
}

const resolveAlias = (checker, symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

const statementOf = (decl) => (ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) ? decl.parent.parent : decl);

// Top-level declarations of the same file that `decl` refers to, transitively, except those in `skip`.
function sameFileDependencies(checker, decl, skip, found) {
  const sf = decl.getSourceFile();
  const visit = (node) => {
    let name;
    if (ts.isTypeReferenceNode(node)) name = node.typeName;
    else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
    else if (ts.isTypeQueryNode(node)) name = node.exprName;
    while (name && (ts.isQualifiedName(name) || ts.isPropertyAccessExpression(name))) name = ts.isQualifiedName(name) ? name.left : name.expression;
    const symbol = name && ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
    if (symbol && !(symbol.flags & ts.SymbolFlags.Alias)) {
      for (const d of symbol.declarations ?? []) {
        const stmt = statementOf(d);
        if (stmt.parent !== sf || skip.has(stmt) || found.has(stmt)) continue;
        found.set(stmt, symbol.name);
        sameFileDependencies(checker, stmt, skip, found);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(decl);
  return found;
}

function externalSection(program, pkgDir, entryFiles) {
  const checker = program.getTypeChecker();
  const items = [];
  const seen = new Set();
  for (const sf of entryFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    for (const exp of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target = resolveAlias(checker, exp);
      const decls = (target.declarations ?? []).filter((d) => !isInside(pkgDir, real(d.getSourceFile().fileName)));
      if (decls.length === 0) continue;
      const key = `${exp.name}|${decls.map((d) => `${d.getSourceFile().fileName}:${d.pos}`).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name: exp.name, target, decls });
    }
  }
  items.sort((a, b) => byCodePoint(a.name, b.name));
  const reexported = new Set(items.flatMap((i) => i.decls.map(statementOf)));
  const printed = new Set();
  const blocks = [];
  const packages = new Set();
  for (const { name, target, decls } of items) {
    const from = packageNameOf(decls[0].getSourceFile().fileName);
    packages.add(from);
    const label = target.name === name || target.name === 'default' ? name : `${name} = ${target.name}`;
    const statements = [...new Set(decls.map(statementOf))];
    const text = statements.map((s) => print(s)).join('\n');
    const values = decls.map((d) => externalValue(d, target.name)).join('');
    blocks.push(`// ${label} (${from})\n${text}${values}`);
    const helpers = new Map();
    for (const s of statements) sameFileDependencies(checker, s, reexported, helpers);
    const sorted = [...helpers.entries()].sort(([sa, a], [sb, b]) => byCodePoint(a, b) || sa.pos - sb.pos);
    for (const [stmt, helperName] of sorted) {
      if (printed.has(stmt)) continue;
      printed.add(stmt);
      blocks.push(`// ${helperName} (${from}, not re-exported, used by ${name})\n${print(stmt)}`);
    }
  }
  return { text: blocks.join('\n\n'), packages };
}

function checkDiagnostics(program, files) {
  const errors = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...files.flatMap(({ sf }) => [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)])].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(`the contract files do not compile (run the root build first):\n${formatDiagnostics(errors)}`);
}

const fence = (heading, body) => `## ${heading}\n\n\`\`\`ts\n${body}\n\`\`\`\n`;

function analyzePackage({ dir, entries, tsconfig = 'tsconfig.mjs.json' }) {
  requireTs();
  const pkgDir = real(dir);
  const program = createProgram(dir, tsconfig, entries);
  const entryFiles = entries.map((e) => {
    const sf = program.getSourceFile(resolve(dir, e)) ?? program.getSourceFiles().find((f) => real(f.fileName) === real(resolve(dir, e)));
    if (!sf) throw new Error(`entry ${e} is not in the program of ${dir}`);
    return sf;
  });
  const files = closureOf(program, pkgDir, entryFiles);
  checkDiagnostics(program, files);

  const name = packageNameOf(join(dir, 'package.json'));
  const sections = files.map(({ path, sf }) => fence(path.slice(pkgDir.length + 1), declarationText(program, sf) + valuesSection(sf)));
  const external = externalSection(program, pkgDir, entryFiles);
  if (external.text) sections.push(fence('Re-exported from other packages', external.text));

  const header = [`# ${name} API snapshot`, '', 'Generated by `node scripts/api-snapshot.mjs` from the declarations and constant values of the frozen contract entry points (plan §1 rule 3). Do not edit: run `npm run build`, then `node scripts/api-snapshot.mjs --update`. After gate G1 a change here needs an RFC in `docs/plans/authz-v3-rfc/`.', '', `Entries: ${entries.map((e) => `\`${e}\``).join(', ')}.`, ''].join('\n');
  return { name, markdown: `${header}\n${sections.join('\n')}`, files: files.map((f) => f.path), externalPackages: external.packages };
}

/** The snapshot markdown of one package; `entries` are relative to `dir`. */
export function snapshotPackage(pkg) {
  return analyzePackage(pkg).markdown;
}

export function loadConfig(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'scripts', 'api-snapshot.json'), 'utf8'));
}

export const snapshotPathOf = (name) => `packages/${name}/etc/${name}.api.md`;

/**
 * Generates every configured snapshot. Returns them by repo-relative path, plus the
 * targets an augmentation must not reach: the snapshotted and pending packages, the
 * packages they re-export from, and the snapshotted files (repo-relative).
 */
export function generateSnapshots(root = ROOT, config = loadConfig(root)) {
  const rootDir = real(root);
  const snapshots = new Map();
  const targets = { packages: new Set(), files: new Set() };
  for (const [pkg, entries] of Object.entries(config.packages)) {
    const res = analyzePackage({ dir: join(root, 'packages', pkg), entries, tsconfig: config.tsconfig });
    snapshots.set(snapshotPathOf(pkg), res.markdown);
    targets.packages.add(res.name);
    for (const p of res.externalPackages) targets.packages.add(p);
    for (const f of res.files) targets.files.add(f.slice(rootDir.length + 1));
  }
  for (const { pkg, rel } of frozenPatternFiles(root)) if (isPending(config, rel)) targets.packages.add(packageNameOf(join(root, 'packages', pkg, 'package.json')));
  return { snapshots, targets };
}

/** Repo-relative path => content of every committed packages/<pkg>/etc/*.api.md. */
export function readCommittedSnapshots(root = ROOT) {
  const out = new Map();
  const packages = join(root, 'packages');
  for (const pkg of readdirSync(packages).sort(byCodePoint)) {
    const etc = join(packages, pkg, 'etc');
    if (!existsSync(etc)) continue;
    for (const f of readdirSync(etc).sort(byCodePoint)) if (f.endsWith('.api.md')) out.set(`packages/${pkg}/etc/${f}`, readFileSync(join(etc, f), 'utf8'));
  }
  return out;
}

function walkTs(dir, out = []) {
  for (const entry of readdirSync(dir).sort(byCodePoint)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (/\.[cm]?ts$/.test(entry)) out.push(p);
  }
  return out;
}

function resolveRelativeModule(rootDir, file, spec) {
  let base = toPosix(resolve(dirname(real(file)), spec));
  // A built file under lib/ declares what its source under src/ declares.
  const built = base.startsWith(`${rootDir}/`) && base.slice(rootDir.length + 1).match(/^(packages\/[^/]+)\/lib\/(?:mjs|cjs)\/(.+?)(?:\.d\.[cm]?ts|\.[cm]?js)?$/);
  if (built) base = `${rootDir}/${built[1]}/src/${built[2]}`;
  const stripped = base.replace(/\.([cm]?)js$/, '.$1ts');
  for (const candidate of [stripped, base, `${base}.ts`, `${base}.d.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return real(candidate).slice(rootDir.length + 1);
  }
  return undefined;
}

/**
 * `declare module` blocks in any packages/<pkg>/src/**\/*.ts whose target is a snapshotted
 * package (or a subpath of it) or resolves to a snapshotted file. Such a block merges into
 * a frozen declaration without touching the snapshot. `declare global` cannot reach a
 * module's declarations, so it is not reported.
 */
export function findAugmentations(root, targets, allowlist = []) {
  requireTs();
  const rootDir = real(root);
  const out = [];
  const packages = join(root, 'packages');
  for (const pkg of readdirSync(packages).sort(byCodePoint)) {
    const src = join(packages, pkg, 'src');
    if (!existsSync(src)) continue;
    for (const file of walkTs(src)) {
      const rel = real(file).slice(rootDir.length + 1);
      if (allowlist.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('module')) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
      for (const stmt of sf.statements) {
        if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name)) continue;
        const spec = stmt.name.text;
        const hit = spec.startsWith('.') ? targets.files.has(resolveRelativeModule(rootDir, file, spec)) : [...targets.packages].some((p) => spec === p || spec.startsWith(`${p}/`));
        if (hit) out.push(`${rel}: declare module '${spec}'`);
      }
    }
  }
  return out.sort(byCodePoint);
}

function frozenPatternFiles(root) {
  const out = [];
  const packages = join(root, 'packages');
  for (const pkg of readdirSync(packages).sort(byCodePoint)) {
    if (!FROZEN_PACKAGE.test(pkg)) continue;
    for (const file of FROZEN_FILES) {
      const rel = `packages/${pkg}/${file}`;
      if (existsSync(join(root, rel))) out.push({ pkg, file, rel });
    }
  }
  return out;
}

// A pending entry is a path prefix: `packages/authn` covers every packages/authn* file.
const isPending = (config, rel) => (config.pending ?? []).some((p) => rel.startsWith(p));

/** Files of a rule 3 pattern in an authz* or authn* package that neither a config entry nor `pending` covers. */
export function unconfiguredFrozenFiles(root, config) {
  return frozenPatternFiles(root)
    .filter(({ pkg, file, rel }) => !config.packages[pkg]?.includes(file) && !isPending(config, rel))
    .map(({ rel }) => rel);
}

const MAX_DIFF_LINES = 8;

function firstDifference(committed, generated) {
  const a = committed.split('\n');
  const b = generated.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const lines = [`  first difference at line ${start + 1}:`];
  for (const l of removed.slice(0, MAX_DIFF_LINES)) lines.push(`  - ${l}`);
  if (removed.length > MAX_DIFF_LINES) lines.push(`  - ... ${removed.length - MAX_DIFF_LINES} more`);
  for (const l of added.slice(0, MAX_DIFF_LINES)) lines.push(`  + ${l}`);
  if (added.length > MAX_DIFF_LINES) lines.push(`  + ... ${added.length - MAX_DIFF_LINES} more`);
  return lines.join('\n');
}

/** Compares generated snapshots with committed ones; CRLF in committed files (git autocrlf) does not count. */
export function compareSnapshots(generated, committed) {
  const problems = [];
  const paths = [...new Set([...generated.keys(), ...committed.keys()])].sort(byCodePoint);
  for (const path of paths) {
    const want = generated.get(path);
    const have = committed.get(path)?.replace(/\r\n/g, '\n');
    if (have === undefined) problems.push(`${path}: missing`);
    else if (want === undefined) problems.push(`${path}: extra (no package in scripts/api-snapshot.json produces it)`);
    else if (have !== want) problems.push(`${path}: stale\n${firstDifference(have, want)}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Parses `git diff --name-status --no-renames` output. */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
}

/** After G1 (gateReached), a changed snapshot needs an added or modified docs/plans/authz-v3-rfc/<lane>-<n>.md. */
export function rfcDecision(changes, gateReached) {
  const snapshots = changes.filter((c) => SNAPSHOT_PATH.test(c.path)).map((c) => c.path);
  const rfcs = changes.filter((c) => RFC_FILE.test(c.path) && (c.status === 'A' || c.status === 'M')).map((c) => c.path);
  if (!gateReached) return { ok: true, snapshots, rfcs, message: `gate G1 not reached (tag ${G1_TAG} is not an ancestor of HEAD): the RFC rule does not apply yet` };
  if (snapshots.length === 0) return { ok: true, snapshots, rfcs, message: 'no API snapshot changed' };
  if (rfcs.length > 0) return { ok: true, snapshots, rfcs, message: `API snapshots changed with RFC ${rfcs.join(', ')}` };
  return {
    ok: false,
    snapshots,
    rfcs,
    message: `frozen contract APIs changed without an RFC (plan §1 rule 3); add docs/plans/authz-v3-rfc/<lane>-<n>.md in the same change:\n${snapshots.map((s) => `  ${s}`).join('\n')}`,
  };
}

function git(args, root) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (res.error) throw new Error(`git ${args[0]} failed to start: ${res.error.message}`);
  return res;
}

export function g1Reached(root = ROOT) {
  if (git(['rev-parse', '-q', '--verify', `refs/tags/${G1_TAG}^{commit}`], root).status !== 0) return { reached: false, tagFound: false };
  return { reached: git(['merge-base', '--is-ancestor', G1_TAG, 'HEAD'], root).status === 0, tagFound: true };
}

function check() {
  const config = loadConfig();
  const { snapshots, targets } = generateSnapshots(ROOT, config);
  const problems = [];
  const drift = compareSnapshots(snapshots, readCommittedSnapshots());
  if (!drift.ok) problems.push(`API snapshots differ from the frozen contracts:\n${drift.problems.join('\n')}\nRun \`npm run build\`, then \`node scripts/api-snapshot.mjs --update\`, and commit the snapshots; after gate G1 add an RFC in docs/plans/authz-v3-rfc/.`);
  const augmentations = findAugmentations(ROOT, targets, config.augmentationAllowlist ?? []);
  if (augmentations.length > 0) problems.push(`module augmentations change frozen contracts without touching the snapshots (plan §1 rule 3 needs an RFC; an approved one goes in augmentationAllowlist in scripts/api-snapshot.json):\n${augmentations.map((a) => `  ${a}`).join('\n')}`);
  const unconfigured = unconfiguredFrozenFiles(ROOT, config);
  if (unconfigured.length > 0) problems.push(`frozen contract files with no snapshot; add them to packages (or pending) in scripts/api-snapshot.json:\n${unconfigured.map((u) => `  ${u}`).join('\n')}`);
  if (problems.length === 0) {
    console.log('API snapshots are up to date');
    return 0;
  }
  console.error(problems.join('\n\n'));
  return 1;
}

function main(argv) {
  const [mode = '--update', base] = argv;
  if (mode === '--update') {
    const { snapshots } = generateSnapshots();
    for (const [path, text] of snapshots) {
      mkdirSync(dirname(join(ROOT, path)), { recursive: true });
      writeFileSync(join(ROOT, path), text);
      console.log(`wrote ${path}`);
    }
    for (const path of readCommittedSnapshots().keys()) {
      if (snapshots.has(path)) continue;
      rmSync(join(ROOT, path));
      console.log(`removed ${path} (no package in scripts/api-snapshot.json produces it)`);
    }
    return 0;
  }
  if (mode === '--check') return check();
  if (mode === '--check-rfc') {
    if (!base) throw new Error('--check-rfc needs a base ref');
    const diff = git(['diff', '--name-status', '--no-renames', `${base}...HEAD`], ROOT);
    if (diff.status !== 0) throw new Error(`git diff ${base}...HEAD failed:\n${diff.stderr}`);
    const gate = g1Reached();
    if (!gate.tagFound) console.log(`notice: tag ${G1_TAG} is not in this clone; if G1 has passed, fetch the tags (git fetch --tags) and run again`);
    const res = rfcDecision(parseNameStatus(diff.stdout), gate.reached);
    (res.ok ? console.log : console.error)(res.message);
    return res.ok ? 0 : 1;
  }
  throw new Error(`unknown option ${mode}; use --update, --check or --check-rfc <base-ref>`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  }
}
