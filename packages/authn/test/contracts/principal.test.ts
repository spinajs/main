import * as chai from 'chai';
import 'mocha';

import { SYSTEM, UNATTENDED, principalKey, ceilingHash, Ceiling, Principal, PrincipalRef, ResourceRef } from '../../src/contracts/principal.js';

const expect = chai.expect;

describe('principal contracts', () => {
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
          { type: 'a%25', id: 'c' },
          { type: 'a%', id: 'c' },
        ],
        [
          { type: 'user', id: '' },
          { type: 'user:', id: '' },
        ],
        [
          { type: '', id: 'user:1' },
          { type: 'user', id: '1' },
        ],
      ];
      for (const [a, b] of pairs) {
        expect(principalKey(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).to.not.eq(principalKey(b));
      }
    });

    it('accepts a full principal', () => {
      expect(principalKey(SYSTEM)).to.eq('system:system');
      expect(principalKey(UNATTENDED)).to.eq('unattended:unattended');
    });
  });

  describe('ceilingHash', () => {
    it('returns an empty string for no ceiling', () => {
      expect(ceilingHash(undefined)).to.eq('');
    });

    it('never returns an empty string for a ceiling', () => {
      expect(ceilingHash({})).to.not.eq('');
      expect(ceilingHash({ roles: [] })).to.not.eq('');
    });

    it('ignores array order', () => {
      const a: Ceiling = {
        roles: ['admin', 'editor'],
        permissions: ['file:*', 'project:read'],
        resources: [{ type: 'file', id: '1' }, { type: 'project' }, { type: 'file', id: '2' }],
      };
      const b: Ceiling = {
        roles: ['editor', 'admin'],
        permissions: ['project:read', 'file:*'],
        resources: [{ type: 'file', id: '2' }, { type: 'file', id: '1' }, { type: 'project' }],
      };
      expect(ceilingHash(a)).to.eq(ceilingHash(b));
    });

    it('ignores duplicates', () => {
      expect(ceilingHash({ roles: ['a', 'a', 'b'] })).to.eq(ceilingHash({ roles: ['b', 'a'] }));
      expect(ceilingHash({ permissions: ['x:read', 'x:read'] })).to.eq(ceilingHash({ permissions: ['x:read'] }));
      expect(
        ceilingHash({
          resources: [
            { type: 'f', id: '1' },
            { type: 'f', id: '1' },
          ],
        }),
      ).to.eq(ceilingHash({ resources: [{ type: 'f', id: '1' }] }));
    });

    it('hashes an absent field and an empty array differently', () => {
      expect(ceilingHash({ roles: [] })).to.not.eq(ceilingHash({}));
      expect(ceilingHash({ permissions: [] })).to.not.eq(ceilingHash({}));
      expect(ceilingHash({ resources: [] })).to.not.eq(ceilingHash({}));
    });

    it('treats a field set to undefined as absent', () => {
      expect(ceilingHash({ roles: undefined, reason: undefined })).to.eq(ceilingHash({}));
    });

    it('changes when any field changes', () => {
      const base: Ceiling = {
        roles: ['a'],
        permissions: ['x:read'],
        resources: [{ type: 'f', id: '1' }],
        expiresAt: new Date(1000),
        reason: 'ceiling',
      };
      const variants: Ceiling[] = [
        { ...base, roles: ['b'] },
        { ...base, roles: ['a', 'b'] },
        { ...base, roles: undefined },
        { ...base, permissions: ['x:write'] },
        { ...base, permissions: undefined },
        { ...base, resources: [{ type: 'f', id: '2' }] },
        { ...base, resources: [{ type: 'g', id: '1' }] },
        { ...base, resources: [{ type: 'f' }] },
        { ...base, resources: undefined },
        { ...base, expiresAt: new Date(1001) },
        { ...base, expiresAt: undefined },
        { ...base, reason: 'link_invalid' },
        { ...base, reason: undefined },
      ];
      const hashes = new Set([ceilingHash(base), ...variants.map((v) => ceilingHash(v))]);
      expect(hashes.size).to.eq(variants.length + 1);
    });

    it('does not mix values between fields', () => {
      expect(ceilingHash({ roles: ['x'] })).to.not.eq(ceilingHash({ permissions: ['x'] }));
      expect(ceilingHash({ roles: ['a,b'] })).to.not.eq(ceilingHash({ roles: ['a', 'b'] }));
      expect(ceilingHash({ reason: 'null' })).to.not.eq(ceilingHash({}));
    });

    it('hashes an invalid date differently from an absent one', () => {
      expect(ceilingHash({ expiresAt: new Date(NaN) })).to.not.eq(ceilingHash({}));
      expect(ceilingHash({ expiresAt: new Date(NaN) })).to.not.eq(ceilingHash({ expiresAt: new Date(0) }));
    });

    it('hashes equal instants equally', () => {
      expect(ceilingHash({ expiresAt: new Date('2026-01-01T00:00:00Z') })).to.eq(ceilingHash({ expiresAt: new Date(Date.UTC(2026, 0, 1)) }));
    });

    it('tells a type-level resource from one with an empty id', () => {
      const typeLevel: ResourceRef = { type: 'a' };
      const emptyId: ResourceRef = { type: 'a', id: '' };
      expect(ceilingHash({ resources: [typeLevel] })).to.not.eq(ceilingHash({ resources: [emptyId] }));
    });

    it('does not let a separator in a resource collide', () => {
      expect(ceilingHash({ resources: [{ type: 'a:b', id: 'c' }] })).to.not.eq(ceilingHash({ resources: [{ type: 'a', id: 'b:c' }] }));
    });

    it('covers every field of Ceiling and ResourceRef', () => {
      // Compile-time guard: a new field fails type-checking here until ceilingHash encodes it.
      const ceilingFields: Record<keyof Ceiling, true> = { roles: true, permissions: true, resources: true, expiresAt: true, reason: true };
      const resourceFields: Record<keyof ResourceRef, true> = { type: true, id: true };
      expect(Object.keys(ceilingFields)).to.have.length(5);
      expect(Object.keys(resourceFields)).to.have.length(2);
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
        expect(() => {
          (p as { id: string }).id = 'x';
        }).to.throw(TypeError);
        expect(() => {
          (p.attributes as Record<string, unknown>).x = 1;
        }).to.throw(TypeError);
      }
    });

    it('are typed as Principal', () => {
      const ps: Principal[] = [SYSTEM, UNATTENDED];
      expect(ps).to.have.length(2);
    });
  });
});

describe('@spinajs/authn root entry', () => {
  it('exports the contracts with the same identity as the subpath', async () => {
    const root = await import('@spinajs/authn');
    const sub = await import('@spinajs/authn/contracts');
    expect(root.SYSTEM).to.eq(sub.SYSTEM);
    expect(root.UNATTENDED).to.eq(sub.UNATTENDED);
    expect(root.principalKey).to.eq(sub.principalKey);
    expect(root.ceilingHash).to.eq(sub.ceilingHash);
  });
});
