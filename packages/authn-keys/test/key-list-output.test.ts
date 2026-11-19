import 'mocha';
import assert from 'node:assert/strict';
import { generateKeyPair } from '@spinajs/authn-testing';
import { AddKey, ListKeys } from '../src/cli/index.js';
import { captureStdio as run, keysParts } from './harness.js';

describe('authn:key-list output', () => {
  it('prints one line per key on stdout and nothing on stderr', async () => {
    const p = await keysParts({}, 'memory');
    const kp = generateKeyPair('EdDSA');

    const add = new AddKey();
    Object.defineProperty(add, 'Log', { value: { success: () => undefined } });
    Object.defineProperty(add, 'Registry', { value: p.registry });
    await add.execute('service', 'runner-2', { jwk: JSON.stringify(kp.publicJwk), name: 'runner' });

    const list = new ListKeys();
    Object.defineProperty(list, 'Registry', { value: p.registry });
    const { stdout, stderr } = await run(() => list.execute('service', 'runner-2'));

    const lines = stdout.trimEnd().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith(`${kp.kid}  EdDSA  runner  created `), lines[0]);
    assert.strictEqual(stderr, '');
  });

  it('prints "No keys" on stdout for an owner without keys', async () => {
    const p = await keysParts({}, 'memory');

    const list = new ListKeys();
    Object.defineProperty(list, 'Registry', { value: p.registry });
    const { stdout, stderr } = await run(() => list.execute('service', 'nobody'));

    assert.strictEqual(stdout.trimEnd(), 'No keys');
    assert.strictEqual(stderr, '');
  });
});
