import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = createRequire(import.meta.url)(join(root, '.dependency-cruiser.cjs'));
const RULES = ['client-runtime-self-contained', 'client-formats-leaf', 'client-mocks-self-contained'];
const rules = config.forbidden.filter((r) => RULES.includes(r.name));

async function violations(baseDir, entry, tsConfig) {
  const options = { baseDir, ruleSet: { forbidden: rules }, validate: true, tsPreCompilationDeps: true, doNotFollow: { path: ['node_modules', '(^|/)lib/'] }, ...(tsConfig ? { tsConfig: { fileName: tsConfig } } : {}) };
  const { output } = await cruise([entry], options, { extensions: ['.ts', '.js', '.d.ts'] }, tsConfig ? { tsConfig: extractTSConfig(tsConfig) } : undefined);
  return output.summary.violations.filter((v) => RULES.includes(v.rule.name)).map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`);
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'depcruise-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

test('client runtime/ and mocks/ import only themselves and formats/, and formats/ only itself', async () => {
  assert.deepEqual(rules.map((r) => r.name).sort(), [...RULES].sort(), 'every rule is in .dependency-cruiser.cjs');
  const dir = tree({
    'packages/client/src/generate/model.ts': 'export const model = 1;\n',
    'packages/client/src/runtime/own.ts': 'export const own = 1;\n',
    'packages/client/src/runtime/index.ts': "import { own } from './own';\nexport const x = own;\n",
    'packages/client/src/runtime/leak.ts': "import { model } from '../generate/model';\nexport const y = model;\n",
    'packages/client/src/runtime/codec.ts': "import { isDate } from '../formats/index';\nexport const c = isDate;\n",
    'packages/client/src/runtime/hook.ts': "import { useState } from 'react';\nexport const h = useState;\n",
    'packages/client/src/formats/index.ts': "import { readFileSync } from 'node:fs';\nimport { own } from './own';\nexport const isDate = own;\nexport const z = readFileSync;\n",
    'packages/client/src/formats/own.ts': 'export const own = 1;\n',
    'packages/client/src/formats/back.ts': "import type { T } from '../runtime/types';\nexport type B = T;\n",
    'packages/client/src/runtime/types.ts': 'export type T = string;\n',
    'packages/client/src/generate/uses-runtime.ts': "import { own } from '../runtime/own';\nexport const w = own;\n",
    'packages/client/src/mocks/index.ts': "import { isDate } from '../formats/index';\nimport { own } from './own';\nexport const m = [isDate, own];\n",
    'packages/client/src/mocks/own.ts': 'export const own = 1;\n',
    'packages/client/src/mocks/leak.ts': "import type { T } from '../runtime/types';\nimport { model } from '../generate/model';\nexport type L = T;\nexport const l = model;\n",
    'packages/client/src/mocks/faker.ts': "import { randomInt } from 'node:crypto';\nexport const f = randomInt;\n",
    'packages/client/src/runtime/uses-mocks.ts': "import { own } from '../mocks/own';\nexport const u = own;\n",
    'packages/client/src/generate/uses-mocks.ts': "import { own } from '../mocks/own';\nexport const g = own;\n",
  });
  try {
    assert.deepEqual((await violations(dir, 'packages')).sort(), [
      'client-formats-leaf: packages/client/src/formats/back.ts -> packages/client/src/runtime/types.ts',
      'client-formats-leaf: packages/client/src/formats/index.ts -> fs',
      'client-mocks-self-contained: packages/client/src/mocks/faker.ts -> crypto',
      'client-mocks-self-contained: packages/client/src/mocks/leak.ts -> packages/client/src/generate/model.ts',
      'client-mocks-self-contained: packages/client/src/mocks/leak.ts -> packages/client/src/runtime/types.ts',
      'client-runtime-self-contained: packages/client/src/runtime/hook.ts -> react',
      'client-runtime-self-contained: packages/client/src/runtime/leak.ts -> packages/client/src/generate/model.ts',
      'client-runtime-self-contained: packages/client/src/runtime/uses-mocks.ts -> packages/client/src/mocks/own.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the client package itself has no violation of the rules', async () => {
  assert.deepEqual(await violations(root, 'packages/client/src', join(root, 'tsconfig.json')), []);
});
