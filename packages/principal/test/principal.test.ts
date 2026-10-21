import * as chai from 'chai';
import 'mocha';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as authnContracts from '@spinajs/authn/contracts';
import * as principal from '@spinajs/principal';
import { SYSTEM, UNATTENDED, ceilingHash, principalKey, sameRef } from '../src/index.js';
import type { Ceiling, IAuthnPrincipalStorage, PrincipalRef } from '../src/index.js';

const expect = chai.expect;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_EXPORTS = ['SYSTEM', 'UNATTENDED', 'principalKey', 'sameRef', 'ceilingHash'] as const;

describe('@spinajs/principal', () => {
  describe('principalKey', () => {
    it('joins type and id with a colon', () => {
      expect(principalKey({ type: 'user', id: '42' })).to.eq('user:42');
      expect(principalKey({ type: 'service', id: 'mailer' })).to.eq('service:mailer');
    });

    it('keeps the id unchanged, colons included', () => {
      expect(principalKey({ type: 'link', id: 'a:b%c' })).to.eq('link:a:b%c');
    });

    it('escapes % and : in the type part', () => {
      expect(principalKey({ type: 'a:b', id: 'c' })).to.eq('a%3Ab:c');
      expect(principalKey({ type: 'a%b', id: 'c' })).to.eq('a%25b:c');
      expect(principalKey({ type: '%3A', id: 'x' })).to.eq('%253A:x');
      expect(principalKey({ type: 'a:b%', id: 'c:d' })).to.eq('a%3Ab%25:c:d');
    });

    it('is injective on pairs that would collide without escaping', () => {
      const pairs: Array<[PrincipalRef, PrincipalRef]> = [
        [
          { type: 'a:b', id: 'c' },
          { type: 'a', id: 'b:c' },
        ],
        [
          { type: 'a%3Ab', id: 'c' },
          { type: 'a:b', id: 'c' },
        ],
        [
          { type: 'user', id: '' },
          { type: 'user:', id: '' },
        ],
      ];
      for (const [a, b] of pairs) expect(principalKey(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).to.not.eq(principalKey(b));
    });

    it('keys the singletons', () => {
      expect(principalKey(SYSTEM)).to.eq('system:system');
      expect(principalKey(UNATTENDED)).to.eq('unattended:unattended');
    });
  });

  describe('sameRef', () => {
    it('compares type and id only', () => {
      expect(sameRef({ type: 'user', id: '1' }, { ...SYSTEM, type: 'user', id: '1' })).to.eq(true);
      expect(sameRef({ type: 'user', id: '1' }, { type: 'service', id: '1' })).to.eq(false);
      expect(sameRef({ type: 'user', id: '1' }, { type: 'user', id: '2' })).to.eq(false);
    });
  });

  describe('ceilingHash', () => {
    it('keeps the serialization authn shipped', () => {
      expect(ceilingHash(undefined)).to.eq('');
      expect(ceilingHash({})).to.eq('[null,null,null,null,null]');
      expect(ceilingHash({ resources: [] })).to.eq('[null,null,[],null,null]');
      expect(ceilingHash({ expiresAt: new Date(NaN) })).to.eq('[null,null,null,"invalid",null]');
      expect(
        ceilingHash({
          roles: ['b', 'a', 'a'],
          permissions: [],
          resources: [{ type: 'f', id: '1' }, { type: 'f' }],
          expiresAt: new Date(5),
          reason: 'r',
        }),
      ).to.eq('[["a","b"],[],["[\\"f\\",\\"1\\"]","[\\"f\\",null]"],5,"r"]');
    });

    it('ignores order and duplicates, and tells absent from empty', () => {
      const a: Ceiling = { roles: ['admin', 'editor'], resources: [{ type: 'file', id: '1' }, { type: 'project' }] };
      const b: Ceiling = { roles: ['editor', 'admin', 'admin'], resources: [{ type: 'project' }, { type: 'file', id: '1' }] };
      expect(ceilingHash(a)).to.eq(ceilingHash(b));
      expect(ceilingHash({ roles: [] })).to.not.eq(ceilingHash({}));
      expect(ceilingHash({ roles: undefined, reason: undefined })).to.eq(ceilingHash({}));
    });
  });

  describe('SYSTEM and UNATTENDED', () => {
    it('have the documented shape', () => {
      expect(SYSTEM).to.deep.eq({ type: 'system', id: 'system', authenticated: true, source: 'runAs', attributes: {} });
      expect(UNATTENDED).to.deep.eq({ type: 'unattended', id: 'unattended', authenticated: false, source: 'unattended', attributes: {} });
    });

    it('are deep-frozen', () => {
      for (const p of [SYSTEM, UNATTENDED]) {
        expect(Object.isFrozen(p)).to.eq(true);
        expect(Object.isFrozen(p.attributes)).to.eq(true);
      }
    });
  });

  describe('IAuthnPrincipalStorage', () => {
    it('is the req.storage slot AuthnMiddleware writes', () => {
      const signedIn: IAuthnPrincipalStorage = { AuthnPrincipal: SYSTEM };
      signedIn.AuthnPrincipal = null;
      const none: IAuthnPrincipalStorage = {};
      expect([signedIn, none]).to.have.length(2);

      const source = readFileSync(join(PKG_ROOT, 'src', 'storage.ts'), 'utf8');
      expect(source).to.contain('AuthnMiddleware');
      expect(source).to.contain('null: no or pending credentials');
      expect(source).to.contain('AuthnPrincipalSource');
    });
  });

  describe('package', () => {
    it('depends on no other package', () => {
      const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      expect(pkg.dependencies ?? {}).to.deep.eq({});
      expect(pkg.peerDependencies ?? {}).to.deep.eq({});
    });
  });

  describe('identity across @spinajs/authn/contracts', () => {
    it('authn re-exports the same runtime values (ESM)', () => {
      for (const name of RUNTIME_EXPORTS) expect(authnContracts[name], name).to.eq(principal[name]);
    });

    it('authn re-exports the same runtime values (CJS)', function () {
      this.timeout(30000);
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      const body = `const a = require('@spinajs/authn/contracts');
        const p = require('@spinajs/principal');
        console.log(JSON.stringify(${JSON.stringify(RUNTIME_EXPORTS)}.map((n) => [n, p[n] !== undefined && a[n] === p[n]])));`;
      const r = spawnSync(process.execPath, ['--input-type=commonjs', '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
      expect(r.status, r.stderr).to.eq(0);
      const lines = r.stdout.trim().split(/\r?\n/);
      expect(JSON.parse(lines[lines.length - 1])).to.deep.eq(RUNTIME_EXPORTS.map((n) => [n, true]));
    });
  });
});
