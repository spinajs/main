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
const RULE = 'client-browser-subpaths-self-contained';
const rule = config.forbidden.find((r) => r.name === RULE);

async function violations(baseDir, entry, tsConfig) {
  const options = { baseDir, ruleSet: { forbidden: [rule] }, validate: true, tsPreCompilationDeps: true, doNotFollow: { path: ['node_modules', '(^|/)lib/'] }, ...(tsConfig ? { tsConfig: { fileName: tsConfig } } : {}) };
  const { output } = await cruise([entry], options, { extensions: ['.ts', '.js', '.d.ts'] }, tsConfig ? { tsConfig: extractTSConfig(tsConfig) } : undefined);
  return output.summary.violations.filter((v) => v.rule.name === RULE).map((v) => `${v.from} -> ${v.to}`);
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'depcruise-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

test('client runtime/ and formats/ may import only their own folder', async () => {
  assert.ok(rule, `rule ${RULE} is missing from .dependency-cruiser.cjs`);
  const dir = tree({
    'packages/client/src/generate/model.ts': 'export const model = 1;\n',
    'packages/client/src/runtime/own.ts': 'export const own = 1;\n',
    'packages/client/src/runtime/index.ts': "import { own } from './own';\nexport const x = own;\n",
    'packages/client/src/runtime/leak.ts': "import { model } from '../generate/model';\nexport const y = model;\n",
    'packages/client/src/runtime/types.ts': "import type { Ajv } from '../formats/index';\nexport type T = Ajv;\n",
    'packages/client/src/formats/index.ts': "import { readFileSync } from 'node:fs';\nexport type Ajv = string;\nexport const z = readFileSync;\n",
    'packages/client/src/runtime/hook.ts': "import { useState } from 'react';\nexport const h = useState;\n",
    'packages/client/src/generate/uses-runtime.ts': "import { own } from '../runtime/own';\nexport const w = own;\n",
  });
  try {
    assert.deepEqual((await violations(dir, 'packages')).sort(), [
      'packages/client/src/formats/index.ts -> fs',
      'packages/client/src/runtime/hook.ts -> react',
      'packages/client/src/runtime/leak.ts -> packages/client/src/generate/model.ts',
      'packages/client/src/runtime/types.ts -> packages/client/src/formats/index.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the client package itself has no violation of the rule', async () => {
  assert.deepEqual(await violations(root, 'packages/client/src', join(root, 'tsconfig.json')), []);
});
