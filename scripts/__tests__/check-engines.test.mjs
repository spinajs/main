import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEngineDrift } from '../check-engines.mjs';

test('reports packages whose engines differ from the root', () => {
  const drift = findEngineDrift({ node: '>=22.0.0' }, [
    { name: '@spinajs/di', engines: { node: '>=22.0.0' } },
    { name: '@spinajs/http', engines: { node: '>=16.11' } },
    { name: '@spinajs/util' },
  ]);
  assert.deepEqual(drift, [
    { name: '@spinajs/http', engines: '>=16.11' },
    { name: '@spinajs/util', engines: undefined },
  ]);
});

test('empty drift when every package matches', () => {
  assert.deepEqual(findEngineDrift({ node: '>=22.0.0' }, [{ name: 'a', engines: { node: '>=22.0.0' } }]), []);
});
