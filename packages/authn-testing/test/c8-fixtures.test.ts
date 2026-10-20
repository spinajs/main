import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import 'mocha';
import { C8_ERROR_CODES, C8_SOURCE, loadC8Fixtures } from '../src/fixtures/index.js';

const DIR = dirname(createRequire(`${process.cwd()}/`).resolve('@spinajs/authn-testing/fixtures/c8/keys.json'));
const FILES = ['keys.json', 'tickets.json'] as const;
const b64 = (s: string) => Buffer.from(s, 'base64url');
const JWS_CODES = ['malformed', 'bad_header', 'unknown_key', 'bad_signature', 'invalid_claims', 'wrong_issuer', 'wrong_audience', 'expired', 'not_yet_valid'];

describe('C8 golden tickets', () => {
  describe('vendored files', () => {
    for (const file of FILES) {
      it(`${file} matches C8_SOURCE and has no CR`, () => {
        const bytes = readFileSync(join(DIR, file));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), C8_SOURCE.files[file].sha256);
        assert.equal(bytes.length, C8_SOURCE.files[file].size);
        assert.ok(!bytes.includes(0x0d));
      });
    }

    it('SOURCE.md names the same commits and hashes', () => {
      const md = readFileSync(join(DIR, 'SOURCE.md'), 'utf8');
      for (const text of [C8_SOURCE.repo, C8_SOURCE.branch, C8_SOURCE.commit, C8_SOURCE.lastChanged, ...FILES.flatMap((f) => [C8_SOURCE.files[f].sha256, String(C8_SOURCE.files[f].size)])]) {
        assert.ok(md.includes(text), text);
      }
    });
  });

  describe('loadC8Fixtures', () => {
    it('finds the package files by name and equals an explicit dir', () => {
      assert.deepStrictEqual(loadC8Fixtures(), loadC8Fixtures(DIR));
    });

    it('throws on a changed copy', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'c8-'));
      try {
        cpSync(DIR, tmp, { recursive: true });
        writeFileSync(join(tmp, 'tickets.json'), readFileSync(join(DIR, 'tickets.json'), 'utf8').replace('canvas-api', 'canvas-apx'));
        assert.throws(() => loadC8Fixtures(tmp), /tickets\.json.*sha256/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('shape', () => {
    const { keys, tickets } = loadC8Fixtures();

    it('has two signing keys with d and the same two public keys without d', () => {
      assert.equal(keys.signing.length, 2);
      assert.ok(keys.signing.every((k) => typeof k.d === 'string'));
      assert.equal(keys.jwks.keys.length, 2);
      assert.ok(keys.jwks.keys.every((k) => !('d' in k)));
      assert.deepStrictEqual(
        keys.jwks.keys.map((k) => k.kid),
        keys.signing.map((k) => k.kid),
      );
    });

    it('has 3 valid and 23 invalid tickets covering every error code', () => {
      assert.equal(tickets.valid.length, 3);
      assert.equal(tickets.invalid.length, 23);
      const seen = new Set<string>(tickets.invalid.map((t) => t.error));
      assert.deepStrictEqual([...seen].sort(), [...C8_ERROR_CODES].sort());
      assert.deepStrictEqual([...C8_ERROR_CODES].sort(), [...JWS_CODES].sort());
    });
  });

  describe('valid tickets belong to the vendored keys', () => {
    const { keys, tickets } = loadC8Fixtures();

    for (const t of tickets.valid) {
      it(t.name, () => {
        const [h, p, s] = t.token.split('.');
        const header = JSON.parse(b64(h).toString('utf8'));
        assert.equal(header.kid, t.kid);
        assert.equal(header.alg, 'EdDSA');
        assert.deepStrictEqual(JSON.parse(b64(p).toString('utf8')), t.claims);

        const input = Buffer.from(`${h}.${p}`);
        const pub = keys.jwks.keys.find((k) => k.kid === t.kid)!;
        const priv = keys.signing.find((k) => k.kid === t.kid)!;
        assert.ok(verify(null, input, createPublicKey({ key: { ...pub } as JsonWebKey, format: 'jwk' }), b64(s)));
        assert.equal(sign(null, input, createPrivateKey({ key: { ...priv } as JsonWebKey, format: 'jwk' })).toString('base64url'), s);
      });
    }
  });
});
