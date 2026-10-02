#!/usr/bin/env node
/**
 * API snapshots of the frozen contract entry points (plan §1 rule 3).
 *
 * For every package in scripts/api-snapshot.json this writes
 * packages/<name>/etc/<name>.api.md: the emitted declarations of each file the
 * entries reach through relative imports, then the declarations of the symbols
 * the entries re-export from other packages. Comments and formatting do not
 * count; any change to a declaration does.
 *
 * Reads the referenced packages' built `.d.ts`, so run `npm run build` first.
 *
 * Usage:
 *   node scripts/api-snapshot.mjs [--update]   write the snapshots
 *   node scripts/api-snapshot.mjs --check      exit 1 when a snapshot is missing, stale or extra
 *   node scripts/api-snapshot.mjs --check-rfc <base-ref>
 *                                              after gate G1, exit 1 when a snapshot changed
 *                                              in <base-ref>...HEAD without an RFC file
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RFC_DIR = 'docs/plans/authz-v3-rfc/';
const G1_TAG = 'authz-v3-g1';
const SNAPSHOT_PATH = /^packages\/[^/]+\/etc\/[^/]+\.api\.md$/;

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

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

// The referenced packages' .d.ts come from TypeScript 7 and keep the source quotes; this
// compiler's emit does not. Printing every string literal fresh makes both agree.
function print(node, sf) {
  const result = ts.transform(node, [
    (ctx) => {
      const visit = (n) => (ts.isStringLiteral(n) ? ts.factory.createStringLiteral(n.text) : ts.visitEachChild(n, visit, ctx));
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  try {
    const out = result.transformed[0];
    return (ts.isSourceFile(out) ? printer.printFile(out) : printer.printNode(ts.EmitHint.Unspecified, out, sf)).trim();
  } finally {
    result.dispose();
  }
}

function reprint(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return print(sf, sf);
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
  for (const { name, target, decls } of items) {
    const from = packageNameOf(decls[0].getSourceFile().fileName);
    const label = target.name === name || target.name === 'default' ? name : `${name} = ${target.name}`;
    const statements = [...new Set(decls.map(statementOf))];
    const text = statements.map((s) => print(s, s.getSourceFile())).join('\n');
    blocks.push(`// ${label} (${from})\n${text}`);
    const helpers = new Map();
    for (const s of statements) sameFileDependencies(checker, s, reexported, helpers);
    const sorted = [...helpers.entries()].sort(([sa, a], [sb, b]) => byCodePoint(a, b) || sa.pos - sb.pos);
    for (const [stmt, helperName] of sorted) {
      if (printed.has(stmt)) continue;
      printed.add(stmt);
      blocks.push(`// ${helperName} (${from}, not re-exported, used by ${name})\n${print(stmt, stmt.getSourceFile())}`);
    }
  }
  return blocks.join('\n\n');
}

function checkDiagnostics(program, files) {
  const errors = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...files.flatMap(({ sf }) => [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)])].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(`the contract files do not compile (run the root build first):\n${formatDiagnostics(errors)}`);
}

const fence = (heading, body) => `## ${heading}\n\n\`\`\`ts\n${body}\n\`\`\`\n`;

/** The snapshot markdown of one package; `entries` are relative to `dir`. */
export function snapshotPackage({ dir, entries, tsconfig = 'tsconfig.mjs.json' }) {
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
  const sections = files.map(({ path, sf }) => fence(path.slice(pkgDir.length + 1), declarationText(program, sf)));
  const external = externalSection(program, pkgDir, entryFiles);
  if (external) sections.push(fence('Re-exported from other packages', external));

  const header = [`# ${name} API snapshot`, '', 'Generated by `node scripts/api-snapshot.mjs` from the declarations of the frozen contract entry points (plan §1 rule 3). Do not edit: run `npm run build`, then `node scripts/api-snapshot.mjs --update`. After gate G1 a change here needs an RFC in `docs/plans/authz-v3-rfc/`.', '', `Entries: ${entries.map((e) => `\`${e}\``).join(', ')}.`, ''].join('\n');
  return `${header}\n${sections.join('\n')}`;
}

export function loadConfig(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'scripts', 'api-snapshot.json'), 'utf8'));
}

export const snapshotPathOf = (name) => `packages/${name}/etc/${name}.api.md`;

/** Repo-relative path => generated markdown, for every configured package. */
export function generateSnapshots(root = ROOT, config = loadConfig(root)) {
  const out = new Map();
  for (const [name, entries] of Object.entries(config.packages)) out.set(snapshotPathOf(name), snapshotPackage({ dir: join(root, 'packages', name), entries, tsconfig: config.tsconfig }));
  return out;
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

/** After G1 (gateReached), a changed snapshot needs an added or modified file under docs/plans/authz-v3-rfc/. */
export function rfcDecision(changes, gateReached) {
  const snapshots = changes.filter((c) => SNAPSHOT_PATH.test(c.path)).map((c) => c.path);
  const rfcs = changes.filter((c) => c.path.startsWith(RFC_DIR) && (c.status === 'A' || c.status === 'M')).map((c) => c.path);
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
  if (res.error) throw res.error;
  return res;
}

export function g1Reached(root = ROOT) {
  if (git(['rev-parse', '-q', '--verify', `refs/tags/${G1_TAG}^{commit}`], root).status !== 0) return false;
  return git(['merge-base', '--is-ancestor', G1_TAG, 'HEAD'], root).status === 0;
}

function main(argv) {
  const [mode = '--update', base] = argv;
  if (mode === '--update') {
    const generated = generateSnapshots();
    for (const [path, text] of generated) {
      mkdirSync(dirname(join(ROOT, path)), { recursive: true });
      writeFileSync(join(ROOT, path), text);
      console.log(`wrote ${path}`);
    }
    for (const path of readCommittedSnapshots().keys()) {
      if (generated.has(path)) continue;
      rmSync(join(ROOT, path));
      console.log(`removed ${path} (no package in scripts/api-snapshot.json produces it)`);
    }
    return 0;
  }
  if (mode === '--check') {
    const res = compareSnapshots(generateSnapshots(), readCommittedSnapshots());
    if (res.ok) {
      console.log('API snapshots are up to date');
      return 0;
    }
    console.error(`API snapshots differ from the frozen contracts:\n${res.problems.join('\n')}\nRun \`npm run build\`, then \`node scripts/api-snapshot.mjs --update\`, and commit the snapshots; after gate G1 add an RFC in ${RFC_DIR}.`);
    return 1;
  }
  if (mode === '--check-rfc') {
    if (!base) throw new Error('--check-rfc needs a base ref');
    const diff = git(['diff', '--name-status', '--no-renames', `${base}...HEAD`], ROOT);
    if (diff.status !== 0) throw new Error(`git diff ${base}...HEAD failed:\n${diff.stderr}`);
    const res = rfcDecision(parseNameStatus(diff.stdout), g1Reached());
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
