import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../type-only-imports.mjs', import.meta.url));

const TSCONFIG = {
  compilerOptions: { target: 'ES2021', module: 'node16', moduleResolution: 'node16', strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false, rootDir: 'src', outDir: 'lib', types: [] },
  include: ['src/**/*'],
};

const SOURCES = {
  'model.ts': 'export class Model {\n  public id = 1;\n}\nexport interface Shape {\n  x: number;\n}\nexport default class Fallback {}\n',
  'mixed.ts': "import { Model, Shape } from './model.js';\nexport function make(): Shape {\n  return { x: new Model().id };\n}\n",
  'types-only.ts': "import Fallback, { Shape } from './model.js';\nexport const origin: Shape = { x: 0 };\nexport type F = Fallback;\n",
  'decorated.ts': "import { Model } from './model.js';\nfunction Dec(): ClassDecorator {\n  return () => undefined;\n}\n@Dec()\nexport class Service {\n  constructor(public model: Model) {}\n}\n",
};

function makePackage() {
  const dir = mkdtempSync(join(tmpdir(), 'type-only-imports-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(dir, 'tsconfig.build.json'), JSON.stringify(TSCONFIG));
  for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(dir, 'src', name), text);
  return dir;
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, dir, ...args], { encoding: 'utf8' });
const read = (dir, name) => readFileSync(join(dir, 'src', name), 'utf8');

test('rewrites the bindings the emit drops and keeps the ones it imports', () => {
  const dir = makePackage();
  try {
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(dir, 'mixed.ts').split('\n').slice(0, 2).join('\n'), "import { Model } from './model.js';\nimport type { Shape } from './model.js';");
    assert.equal(read(dir, 'types-only.ts').split('\n').slice(0, 2).join('\n'), "import type Fallback from './model.js';\nimport type { Shape } from './model.js';");
    // emitDecoratorMetadata references Model at runtime, so the import stays a value import
    assert.equal(read(dir, 'decorated.ts'), SOURCES['decorated.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check fails before the rewrite and passes after it', () => {
  const dir = makePackage();
  try {
    assert.equal(run(dir, '--check').status, 1);
    assert.equal(run(dir).status, 0);
    const again = run(dir, '--check');
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /0 import declaration\(s\) to rewrite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
