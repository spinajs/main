import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ormCycles } from '../check-orm-cycles.mjs';

const entry = (rule, from) => ({ type: 'cycle', from, to: from, rule: { severity: 'error', name: rule }, cycle: [] });

test('counts no-circular entries under packages/orm/src/ only', () => {
  const found = ormCycles([
    entry('no-circular', 'packages/orm/src/model.ts'),
    entry('no-circular', 'packages/orm-sql/src/index.ts'),
    entry('no-circular', 'packages/di/src/binder.ts'),
    entry('src-not-to-dev-dep', 'packages/orm/src/orm.ts'),
  ]);
  assert.deepEqual(found.map((v) => v.from), ['packages/orm/src/model.ts']);
});

test('an empty baseline has no orm cycle', () => {
  assert.deepEqual(ormCycles([]), []);
});
