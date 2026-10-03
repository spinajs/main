import 'mocha';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { generateKeyPair } from '@spinajs/authn-testing';
import { AddKey, CLI_ACTOR, ListKeys, RevokeKey } from '../src/cli/index.js';
import authnKeysConfig from '../src/config/authn-keys.js';
import { keysParts } from './harness.js';
import type { KeysParts } from './harness.js';

type Lines = { success: string[]; info: string[] };

function command<T extends AddKey | ListKeys | RevokeKey>(Type: new () => T, p: KeysParts): { cmd: T; out: Lines } {
  const out: Lines = { success: [], info: [] };
  const cmd = new Type();
  Object.defineProperty(cmd, 'Log', { value: { success: (m: string) => out.success.push(m), info: (m: string) => out.info.push(m) } });
  Object.defineProperty(cmd, 'Registry', { value: p.registry });
  return { cmd, out };
}

describe('authn:key-add, authn:key-list, authn:key-revoke', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'authn-keys-cli-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a service key from inline JWK, lists it and revokes it, recording the CLI as actor', async () => {
    const p = await keysParts({}, 'memory');
    const kp = generateKeyPair('EdDSA');
    const add = command(AddKey, p);
    await add.cmd.execute('service', 'runner-1', { jwk: JSON.stringify({ ...kp.publicJwk, kid: 'ignored', alg: 'RS256' }), name: 'runner', expires: '2099-01-01T00:00:00Z' });
    assert.deepStrictEqual(add.out.success, [`Key registered: kid ${kp.kid}, EdDSA, thumbprint ${kp.kid}`]);
    const [key] = await p.registry.list({ type: 'service', id: 'runner-1' });
    assert.deepStrictEqual({ createdBy: key.createdBy, name: key.name, expiresAt: key.expiresAt?.toISOString() }, { createdBy: CLI_ACTOR, name: 'runner', expiresAt: '2099-01-01T00:00:00.000Z' });

    const list = command(ListKeys, p);
    await list.cmd.execute('service', 'runner-1');
    assert.strictEqual(list.out.info.length, 1);
    assert.ok(list.out.info[0].startsWith(`${kp.kid}  EdDSA  runner  created `) && list.out.info[0].includes('revoked -'), list.out.info[0]);

    const revoke = command(RevokeKey, p);
    await assert.rejects(revoke.cmd.execute('agent', 'runner-1', kp.kid), /no key/, 'another owner type');
    await revoke.cmd.execute('service', 'runner-1', kp.kid);
    assert.deepStrictEqual(revoke.out.success, [`Key ${kp.kid} revoked`]);
    assert.ok((await p.registry.byId(kp.kid))?.revokedAt);
    assert.deepStrictEqual(p.events.all().find((e) => e.type === 'key.revoke')?.actor, CLI_ACTOR);
  });

  it('reads a PEM public key or a JWK file and refuses private keys', async () => {
    const p = await keysParts({}, 'memory');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = join(dir, 'pub.pem');
    writeFileSync(pem, pair.publicKey.export({ format: 'pem', type: 'spki' }));
    const add = command(AddKey, p);
    await add.cmd.execute('agent', 'a-1', { file: pem, kid: 'agent-key-1' });
    assert.ok(add.out.success[0].startsWith('Key registered: kid agent-key-1, ES256'));

    const jwkFile = join(dir, 'pub.json');
    writeFileSync(jwkFile, JSON.stringify(generateKeyPair('EdDSA').publicJwk));
    await add.cmd.execute('agent', 'a-1', { file: jwkFile });

    const priv = join(dir, 'priv.pem');
    writeFileSync(priv, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await assert.rejects(add.cmd.execute('agent', 'a-1', { file: priv }), /never a private key/);
    const privJwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    await assert.rejects(add.cmd.execute('agent', 'a-1', { jwk: JSON.stringify(privJwk) }), /invalid_key/);
  });

  it('refuses user keys, bad input and duplicates', async () => {
    const p = await keysParts({}, 'memory');
    const kp = generateKeyPair('EdDSA');
    const { cmd } = command(AddKey, p);
    await assert.rejects(cmd.execute('user', 'u-1', { jwk: JSON.stringify(kp.publicJwk) }), /proof of possession/);
    await assert.rejects(cmd.execute('group', 'g', { jwk: JSON.stringify(kp.publicJwk) }), /owner type/);
    await assert.rejects(cmd.execute('service', 's', {}), /exactly one of --jwk or --file/);
    await assert.rejects(cmd.execute('service', 's', { jwk: '{', file: 'x' }), /exactly one/);
    await assert.rejects(cmd.execute('service', 's', { jwk: 'not json' }), /neither JSON nor a PEM/);
    await assert.rejects(cmd.execute('service', 's', { jwk: JSON.stringify(kp.publicJwk), expires: 'tomorrow' }), /ISO 8601/);
    await assert.rejects(cmd.execute('service', 's', { jwk: JSON.stringify(kp.publicJwk), kid: 'a b' }), /invalid_key/);
    await assert.rejects(cmd.execute('service', 's', { jwk: JSON.stringify(kp.publicJwk), expires: '2099-01-01T00:00:00' }), /with Z or an offset/);
    await assert.rejects(cmd.execute('service', 's', { jwk: JSON.stringify(kp.publicJwk), expires: '2099-01-01' }), /with Z or an offset/);
    await cmd.execute('service', 's', { jwk: JSON.stringify(kp.publicJwk) });
    await assert.rejects(cmd.execute('service', 's2', { jwk: JSON.stringify(kp.publicJwk) }), /duplicate/);
  });

  it('ships only the CLI scan dir in its config', () => {
    assert.deepStrictEqual(Object.keys(authnKeysConfig.system.dirs), ['cli']);
    assert.ok(authnKeysConfig.system.dirs.cli.every((d) => d.replace(/\\/g, '/').includes('@spinajs/authn-keys/lib/')));
  });
});
