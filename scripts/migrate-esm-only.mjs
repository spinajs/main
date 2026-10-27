#!/usr/bin/env node
/**
 * One-shot mechanical migration to the ESM-only, flat `lib/` layout (4.0, program task A4/A5).
 * Pure functions are exported for tests; `main` applies them to the tree.
 *
 *   node scripts/migrate-esm-only.mjs --all [--dry-run]
 *   node scripts/migrate-esm-only.mjs --tsconfigs --package-json --config-dirs --engines --strip-githead
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const LIB_RE = /\.?\/?lib\/(?:mjs|cjs)\//g;

function fixLibPath(value) {
  return value.replace(LIB_RE, (m) => (m.startsWith('./') ? './lib/' : m.startsWith('/') ? '/lib/' : 'lib/'));
}

export function rewriteExports(value) {
  if (typeof value === 'string') return fixLibPath(value);
  if (Array.isArray(value)) return value.map(rewriteExports);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'require') continue;
      out[key] = rewriteExports(v);
    }
    const keys = Object.keys(out);
    if (keys.length === 1 && keys[0] === 'import') return out.import;
    return out;
  }
  return value;
}

const DROP_PRETEST_PARTS = [
  /\s*&&\s*npm run compile:cjs/g,
  /\s*&&\s*cd \.\.\/\.\. && node node_modules\/typescript-7\/lib\/tsc\.js -b packages\/[^ ]+\/tsconfig\.cjs\.json/g,
  /\s*&&\s*cd \.\.\/\.\. && node scripts\/generate-packages-for-modules\.mjs/g,
  /\s*&&\s*node scripts\/generate-packages-for-modules\.mjs/g,
];

export function rewriteScriptsField(scripts) {
  if (!scripts) return scripts;
  const out = {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (name === 'compile:cjs') continue;
    let v = cmd;
    for (const re of DROP_PRETEST_PARTS) v = v.replace(re, '');
    v = v.replace(/tsconfig\.mjs\.json/g, 'tsconfig.build.json');
    v = fixLibPath(v);
    out[name] = v;
  }
  return out;
}

export function rewritePackageJson(pkg, { engines } = {}) {
  const out = { ...pkg };
  delete out.module;
  delete out.gitHead;
  if (out.exports) out.exports = rewriteExports(out.exports);
  if (out.main) out.main = fixLibPath(out.main.startsWith('.') ? out.main : `./${out.main}`);
  if (out.exports && out.exports['.']) {
    const root = out.exports['.'];
    const types = typeof root === 'object' ? root.types : undefined;
    if (types) out.types = types;
  } else if (out.main && out.main.endsWith('.js')) {
    out.types = out.main.replace(/\.js$/, '.d.ts');
  }
  if (out.bin) out.bin = Object.fromEntries(Object.entries(out.bin).map(([k, v]) => [k, fixLibPath(v)]));
  if (out.typesVersions) out.typesVersions = JSON.parse(fixLibPath(JSON.stringify(out.typesVersions)));
  if (out.scripts) out.scripts = rewriteScriptsField(out.scripts);
  if (engines) out.engines = { node: engines };
  return out;
}

// A build config's rootDir is ./src, so tsc would put its build info beside the tsconfig, where `clean` (rimraf lib/)
// leaves it behind and the next `tsc -b` skips a package whose lib/ is gone.
export function rewriteTsconfig(json, kind) {
  const compilerOptions = {};
  for (const [key, value] of Object.entries(json.compilerOptions ?? {})) {
    compilerOptions[key] = key === 'outDir' ? value.replace(/lib\/mjs\/?$/, 'lib') : value;
    if (key === 'outDir' && kind === 'build') compilerOptions.tsBuildInfoFile = './lib/tsconfig.build.tsbuildinfo';
  }
  const out = { ...json, compilerOptions };
  if (out.references) out.references = out.references.map((r) => ({ path: r.path.replace(/tsconfig\.mjs\.json$/, 'tsconfig.build.json') }));
  return out;
}

export function rewriteRootBuildTsconfig(json) {
  return { ...json, references: json.references.map((r) => ({ path: r.path.replace(/tsconfig\.mjs\.json$/, 'tsconfig.build.json') })) };
}

export function rewriteConfigSource(source) {
  if (!source.includes('typeof module')) return source;
  let out = source.replace(/^[ \t]*const inCommonJs = typeof module !== 'undefined';\r?\n/gm, '');
  out = out.replace(/, inCommonJs \? 'cjs' : 'mjs'/g, '');
  out = out.replace(/^[ \t]*inCommonJs \? 'cjs' : 'mjs',\r?\n/gm, '');
  if (out.includes('typeof module') || out.includes('inCommonJs')) throw new Error(`unhandled typeof module usage:\n${out}`);
  return out;
}

// tsconfig files in this repo contain comments and trailing commas.
export function parseJsonc(text) {
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ''));
  const clean = stripped.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, tail) => (m.startsWith('"') ? m : tail));
  return JSON.parse(clean);
}

function readJson(file) {
  return parseJsonc(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}
function writeJson(file, value, dryRun) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) console.log(`would write ${relative(ROOT, file)}`);
  else writeFileSync(file, text);
}

function packageDirs() {
  return readdirSync(PACKAGES)
    .map((name) => join(PACKAGES, name))
    .filter((dir) => existsSync(join(dir, 'package.json')));
}

function applyTsconfigs(dryRun) {
  for (const dir of packageDirs()) {
    const mjs = join(dir, 'tsconfig.mjs.json');
    const cjs = join(dir, 'tsconfig.cjs.json');
    const test = join(dir, 'tsconfig.json');
    if (existsSync(mjs)) {
      writeJson(join(dir, 'tsconfig.build.json'), rewriteTsconfig(readJson(mjs), 'build'), dryRun);
      if (!dryRun) rmSync(mjs);
    }
    if (existsSync(cjs) && !dryRun) rmSync(cjs);
    if (existsSync(test)) writeJson(test, rewriteTsconfig(readJson(test)), dryRun);
  }
  writeJson(join(ROOT, 'tsconfig.build.json'), rewriteRootBuildTsconfig(readJson(join(ROOT, 'tsconfig.build.json'))), dryRun);
  const rootCjs = join(ROOT, 'tsconfig.build.cjs.json');
  if (existsSync(rootCjs) && !dryRun) rmSync(rootCjs);
}

function applyPackageJson({ engines, dryRun }) {
  for (const dir of packageDirs()) {
    const file = join(dir, 'package.json');
    writeJson(file, rewritePackageJson(readJson(file), { engines }), dryRun);
  }
  if (engines) {
    const rootFile = join(ROOT, 'package.json');
    const root = readJson(rootFile);
    root.engines = { node: engines };
    writeJson(rootFile, root, dryRun);
  }
}

function applyConfigDirs(dryRun) {
  const changed = [];
  for (const dir of packageDirs()) {
    const candidates = [join(dir, 'src', 'config'), join(dir, 'src')];
    for (const c of candidates) {
      if (!existsSync(c)) continue;
      for (const entry of readdirSync(c)) {
        const file = join(c, entry);
        if (!entry.endsWith('.ts') || statSync(file).isDirectory()) continue;
        const before = readFileSync(file, 'utf8');
        if (!before.includes('typeof module')) continue;
        const after = rewriteConfigSource(before);
        changed.push(relative(ROOT, file));
        if (!dryRun) writeFileSync(file, after);
      }
    }
  }
  console.log(`config sources rewritten: ${changed.length}\n  ${changed.join('\n  ')}`);
}

function stripGitHead(dryRun) {
  for (const dir of packageDirs()) {
    const file = join(dir, 'package.json');
    const pkg = readJson(file);
    if ('gitHead' in pkg) {
      delete pkg.gitHead;
      writeJson(file, pkg, dryRun);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f) || args.includes('--all');
  const dryRun = args.includes('--dry-run');
  if (has('--tsconfigs')) applyTsconfigs(dryRun);
  if (has('--package-json')) applyPackageJson({ engines: has('--engines') ? '>=22.0.0' : undefined, dryRun });
  if (has('--config-dirs')) applyConfigDirs(dryRun);
  if (has('--strip-githead')) stripGitHead(dryRun);
  const gen = join(ROOT, 'scripts', 'generate-packages-for-modules.mjs');
  if (has('--tsconfigs') && existsSync(gen) && !dryRun) rmSync(gen);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
