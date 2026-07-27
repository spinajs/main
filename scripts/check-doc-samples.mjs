#!/usr/bin/env node
/**
 * Type-checks the TypeScript samples embedded in the packages' `docs/` markdown.
 *
 * A fenced block participates only when its info string is exactly `ts sample`:
 *
 *     ```ts sample
 *     import { Model, ModelBase } from '@spinajs/orm';
 *     ...
 *     ```
 *
 * Such a block must stand on its own — it carries its own imports and declares
 * everything it references. Blocks fenced as plain ```ts are deliberately partial
 * and are skipped, as is every non-TypeScript fence.
 *
 * Each block is written to .tmp/docs-samples/<package>/<doc>-<n>.ts and the whole
 * directory is compiled once with `tsc --noEmit`. Diagnostics are mapped back to
 * the markdown file and line the block came from.
 *
 * Because the workspace resolves @spinajs/* through symlinks into each package's
 * built `lib/`, run `npm run build` before this.
 *
 * Usage:  node scripts/check-doc-samples.mjs [packageName ...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const OUT = join(ROOT, '.tmp', 'docs-samples');

const FENCE = /^([ \t]*)```([^\n`]*)\n([\s\S]*?)\n?\1```[ \t]*$/gm;
const SAMPLE_INFO = /^ts\s+sample$/;

const only = process.argv.slice(2);

function markdownFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/** Extracts every `ts sample` block, with the 1-based line its body starts on. */
function extract(source) {
  const blocks = [];
  FENCE.lastIndex = 0;
  let match;
  while ((match = FENCE.exec(source)) !== null) {
    const [, indent, info, body] = match;
    if (!SAMPLE_INFO.test(info.trim())) continue;
    // +1 because the opening fence itself occupies a line.
    const line = source.slice(0, match.index).split('\n').length + 1;
    const dedented = indent ? body.replace(new RegExp(`^${indent}`, 'gm'), '') : body;
    blocks.push({ line, body: dedented });
  }
  return blocks;
}

function collect() {
  const samples = [];
  let packages;
  try {
    packages = readdirSync(PACKAGES, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    console.error(`no packages directory at ${PACKAGES}`);
    process.exit(1);
  }

  for (const pkg of packages) {
    if (only.length && !only.includes(pkg)) continue;
    const docs = join(PACKAGES, pkg, 'docs');
    try {
      if (!statSync(docs).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const md of markdownFiles(docs)) {
      const source = readFileSync(md, 'utf8');
      const stem = relative(docs, md).replace(/\.md$/, '').split(sep).join('-');
      extract(source).forEach((block, index) => {
        samples.push({
          pkg,
          markdown: relative(ROOT, md),
          markdownLine: block.line,
          file: join(OUT, pkg, `${stem}-${index + 1}.ts`),
          body: block.body,
        });
      });
    }
  }
  return samples;
}

const samples = collect();

if (samples.length === 0) {
  console.log('no `ts sample` blocks found — nothing to check');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
for (const sample of samples) {
  mkdirSync(dirname(sample.file), { recursive: true });
  writeFileSync(sample.file, `${sample.body}\n`, 'utf8');
}

// Mirrors the packages' own tsconfig, minus the rules that only make sense for
// shipped code: a documentation sample legitimately imports a symbol to show the
// import line, and legitimately declares a parameter it does not use.
writeFileSync(
  join(OUT, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2021',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['esnext', 'dom'],
        noEmit: true,
        strictNullChecks: true,
        noImplicitAny: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true,
        useDefineForClassFields: false,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        baseUrl: '.',
        typeRoots: [join(ROOT, 'node_modules', '@types')],
        types: ['node'],
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const tsc = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
const result = spawnSync(join(ROOT, 'node_modules', '.bin', tsc), ['--noEmit', '-p', join(OUT, 'tsconfig.json')], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status === 0) {
  console.log(`docs:check ok — ${samples.length} sample(s) compiled`);
  process.exit(0);
}

// tsc reports against the generated file; translate back to the markdown source so
// the reader is pointed at the block they have to fix.
const byFile = new Map(samples.map((s) => [relative(ROOT, s.file).split(sep).join('/'), s]));
const translated = output.replace(/^(\S+?\.ts)\((\d+),(\d+)\)/gm, (whole, file, line, column) => {
  const sample = byFile.get(file.split(sep).join('/'));
  if (!sample) return whole;
  return `${sample.markdown}(${sample.markdownLine + Number(line) - 1},${column}) [${file}]`;
});

console.error(translated.trim());
console.error(`\ndocs:check FAILED — ${samples.length} sample(s) checked`);
process.exit(1);
