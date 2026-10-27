import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteExports, rewritePackageJson, rewriteTsconfig, rewriteRootBuildTsconfig, rewriteConfigSource, rewriteScriptsField, parseJsonc } from '../migrate-esm-only.mjs';

test('rewriteExports: plain conditions lose require and lib/mjs', () => {
  assert.deepEqual(
    rewriteExports({ '.': { types: './lib/mjs/index.d.ts', import: './lib/mjs/index.js', require: './lib/cjs/index.js' }, './package.json': './package.json' }),
    { '.': { types: './lib/index.d.ts', import: './lib/index.js' }, './package.json': './package.json' },
  );
});

test('rewriteExports: an import-only condition collapses to a string', () => {
  assert.deepEqual(rewriteExports({ '.': { import: './lib/mjs/index.js', require: './lib/cjs/index.js' } }), { '.': './lib/index.js' });
});

test('rewriteExports: node/browser nesting keeps its shape', () => {
  assert.deepEqual(
    rewriteExports({
      '.': { types: './lib/mjs/index.d.ts', node: { import: './lib/mjs/index.js', require: './lib/cjs/index.js' }, browser: { import: './lib/mjs/index.browser.js', require: './lib/cjs/index.browser.js' } },
      './browser': { import: './lib/mjs/index.browser.js', require: './lib/cjs/index.browser.js' },
    }),
    { '.': { types: './lib/index.d.ts', node: './lib/index.js', browser: './lib/index.browser.js' }, './browser': './lib/index.browser.js' },
  );
});

test('rewritePackageJson: main, types, bin, typesVersions, scripts, engines, gitHead', () => {
  const out = rewritePackageJson(
    {
      name: '@spinajs/upload',
      main: 'lib/cjs/index.js',
      module: 'lib/mjs/index.js',
      exports: { '.': { types: './lib/mjs/index.d.ts', import: './lib/mjs/index.js', require: './lib/cjs/index.js' } },
      typesVersions: { '*': { scheduler: ['lib/cjs/scheduler.d.ts'] } },
      bin: { spinajs: './lib/mjs/cli.js' },
      engines: { node: '>=20.19' },
      gitHead: 'abc',
      scripts: { compile: 'tsc -b tsconfig.mjs.json', 'compile:cjs': 'tsc -b tsconfig.cjs.json', watch: 'tsc -b tsconfig.mjs.json -w', start: 'node lib/mjs/main.js', pretest: 'npm run compile && npm run compile:cjs && cd ../.. && node scripts/generate-packages-for-modules.mjs' },
    },
    { engines: '>=22.0.0' },
  );
  assert.equal(out.main, './lib/index.js');
  assert.equal(out.types, './lib/index.d.ts');
  assert.equal(out.module, undefined);
  assert.equal(out.gitHead, undefined);
  assert.deepEqual(out.engines, { node: '>=22.0.0' });
  assert.deepEqual(out.bin, { spinajs: './lib/cli.js' });
  assert.deepEqual(out.typesVersions, { '*': { scheduler: ['lib/scheduler.d.ts'] } });
  assert.deepEqual(out.scripts, { compile: 'tsc -b tsconfig.build.json', watch: 'tsc -b tsconfig.build.json -w', start: 'node lib/main.js', pretest: 'npm run compile' });
});

test('rewriteScriptsField: authn-http style pretest drops the cjs tsc call', () => {
  assert.deepEqual(
    rewriteScriptsField({ pretest: 'npm run clean && npm run compile && cd ../.. && node node_modules/typescript-7/lib/tsc.js -b packages/authn-http/tsconfig.cjs.json && node scripts/generate-packages-for-modules.mjs' }),
    { pretest: 'npm run clean && npm run compile' },
  );
  assert.deepEqual(rewriteScriptsField({ pretest: 'node ../../node_modules/typescript-7/lib/tsc.js -b tsconfig.mjs.json' }), { pretest: 'node ../../node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json' });
});

test('rewriteTsconfig: build config; its build info moves under lib/ so `clean` removes it with the output', () => {
  assert.deepEqual(
    rewriteTsconfig({ extends: '../../tsconfig.json', compilerOptions: { rootDir: './src', outDir: './lib/mjs', module: 'node16', moduleResolution: 'node16', paths: { '@spinajs': ['../'] } }, references: [{ path: '../util/tsconfig.mjs.json' }], include: ['src/**/*'] }, 'build'),
    { extends: '../../tsconfig.json', compilerOptions: { rootDir: './src', outDir: './lib', tsBuildInfoFile: './lib/tsconfig.build.tsbuildinfo', module: 'node16', moduleResolution: 'node16', paths: { '@spinajs': ['../'] } }, references: [{ path: '../util/tsconfig.build.json' }], include: ['src/**/*'] },
  );
});

test('rewriteTsconfig: test config keeps references and only moves outDir', () => {
  assert.deepEqual(
    rewriteTsconfig({ extends: '../../tsconfig.json', compilerOptions: { rootDir: './', outDir: './lib/mjs', module: 'node16', moduleResolution: 'node16' }, references: [{ path: '../exceptions/tsconfig.json' }], include: ['src/**/*', 'test/**/*'] }, 'test'),
    { extends: '../../tsconfig.json', compilerOptions: { rootDir: './', outDir: './lib', module: 'node16', moduleResolution: 'node16' }, references: [{ path: '../exceptions/tsconfig.json' }], include: ['src/**/*', 'test/**/*'] },
  );
});

test('rewriteTsconfig: a test config reference to a tsconfig.mjs.json follows its rename', () => {
  assert.deepEqual(
    rewriteTsconfig({ compilerOptions: { outDir: './lib/mjs' }, references: [{ path: '../orm/tsconfig.json' }, { path: '../orm-http/tsconfig.mjs.json' }] }, 'test'),
    { compilerOptions: { outDir: './lib' }, references: [{ path: '../orm/tsconfig.json' }, { path: '../orm-http/tsconfig.build.json' }] },
  );
});

test('rewriteRootBuildTsconfig', () => {
  assert.deepEqual(rewriteRootBuildTsconfig({ files: [], references: [{ path: 'packages/cli/tsconfig.mjs.json' }] }), { files: [], references: [{ path: 'packages/cli/tsconfig.build.json' }] });
});

test('rewriteConfigSource: two-element dir()', () => {
  const input = `function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'users', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'users', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}`;
  const expected = `function dir(path: string) {
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'users', 'lib', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'users', 'lib', path))),
  ];
}`;
  assert.equal(rewriteConfigSource(input), expected);
});

test('rewriteConfigSource: http lib() helper and single-dir variants', () => {
  assert.equal(rewriteConfigSource(`  const inCommonJs = typeof module !== 'undefined';\n  return resolve(normalize(join(lib(), inCommonJs ? 'cjs' : 'mjs', path)));`), `  return resolve(normalize(join(lib(), path)));`);
});

test('rewriteConfigSource: prettier-wrapped join() with the flavour on its own line', () => {
  const input = `function dir(path: string) {\n  const inCommonJs = typeof module !== 'undefined';\n  return resolve(\n    normalize(\n      join(\n        'lib',\n        inCommonJs ? 'cjs' : 'mjs',\n        path,\n      ),\n    ),\n  );\n}`;
  const expected = `function dir(path: string) {\n  return resolve(\n    normalize(\n      join(\n        'lib',\n        path,\n      ),\n    ),\n  );\n}`;
  assert.equal(rewriteConfigSource(input), expected);
});

test('rewriteConfigSource: refuses a leftover inCommonJs reference', () => {
  assert.throws(() => rewriteConfigSource(`const inCommonJs = typeof module !== 'undefined';\nconst x = inCommonJs && 1;`), /unhandled typeof module/);
});

test('rewriteConfigSource: a file without the pattern is returned unchanged', () => {
  assert.equal(rewriteConfigSource('export default {};\n'), 'export default {};\n');
});

test('rewriteConfigSource: refuses an unknown typeof module usage', () => {
  assert.throws(() => rewriteConfigSource(`const x = typeof module !== 'undefined' ? 1 : 2;`), /unhandled typeof module/);
});

test('parseJsonc: comments and trailing commas, but not inside strings', () => {
  const text = `{
  // c
  "a": "x // y, ]", /* b */
  "r": [1, 2,],
}`;
  assert.deepEqual(parseJsonc(text), { a: 'x // y, ]', r: [1, 2] });
});
