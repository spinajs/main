import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { decisionKey, entryTags, invalidationTags, principalState, versionVector } from '../../src/engine/cache-key.js';
import { GLOBAL } from '../../src/contracts/resource.js';
import { SYSTEM, UNATTENDED } from '../../src/contracts/principal.js';
import type { Principal, ResourceRef } from '../../src/contracts/principal.js';
import type { AuthorizationModel } from '../../src/contracts/model.js';

const expect = chai.expect;

const AT = new Date('2026-10-01T12:00:00.000Z');

const user = (extra: Record<string, unknown> = {}): Principal =>
  ({
    type: 'user',
    id: 'u1',
    authenticated: true,
    source: 'session',
    attributes: { dept: 'it' },
    authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT) },
    ...extra,
  } as unknown as Principal);

const agent = (extra: Record<string, unknown> = {}): Principal => ({ type: 'agent', id: 'a1', authenticated: true, source: 'token', attributes: {}, ...extra } as unknown as Principal);

const key = (principal: Principal, extra: { actor?: Principal; permission?: string; ref?: ResourceRef; versions?: string; domain?: string } = {}) => decisionKey({ domain: extra.domain ?? 'default', principal, actor: extra.actor, permission: extra.permission ?? 'doc:read', ref: extra.ref ?? { type: 'doc', id: '1' }, versions: extra.versions ?? '[""]' });

const model = (name: string, version?: unknown): AuthorizationModel => {
  const m: Record<string, unknown> = { name };
  if (version !== undefined) m.version = version;
  return m as unknown as AuthorizationModel;
};

describe('cache-key', () => {
  describe('principalState', () => {
    it('is a string for a well-formed principal', () => {
      expect(principalState(user())).to.be.a('string');
    });

    it('is equal for equal principals built separately', () => {
      expect(principalState(user())).to.equal(principalState(user()));
      expect(key(user())).to.equal(key(user()));
    });

    const differing: [string, Record<string, unknown>][] = [
      ['id', { id: 'u2' }],
      ['type', { type: 'service' }],
      ['onBehalfOf', { onBehalfOf: agent() }],
      ['onBehalfOf deeper state', { onBehalfOf: agent({ attributes: { x: 1 } }) }],
      ['delegation', { delegation: 'inherit' }],
      ['companions', { companions: [{ type: 'user', id: 'u9' }] }],
      ['attributes', { attributes: { dept: 'hr' } }],
      ['attribute type', { attributes: { dept: 1 } }],
      ['authn absent', { authn: undefined }],
      ['authn.assurance', { authn: { method: 'password', strategy: 'local', assurance: 'aal2', mfa: [], authenticatedAt: new Date(AT) } }],
      ['authn.mfa', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: ['totp'], authenticatedAt: new Date(AT) } }],
      ['authn.method', { authn: { method: 'oidc', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT) } }],
      ['authn.strategy', { authn: { method: 'password', strategy: 'oidc:google', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT) } }],
      ['authenticatedAt', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT.getTime() + 1) } }],
      ['authenticatedAt invalid', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(NaN) } }],
      ['impersonator', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT), impersonator: { type: 'user', id: 'admin' } } }],
      ['sessionHandle', { authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT), sessionHandle: 'h1' } }],
      ['ceiling', { ceiling: { roles: ['viewer'] } }],
      ['ceiling []', { ceiling: { roles: [] } }],
      ['ceiling expiry', { ceiling: { expiresAt: new Date(AT) } }],
      ['source', { source: 'token' }],
      ['authenticated', { authenticated: false }],
      ['extra top-level key', { tenant: 't1' }],
    ];
    for (const [what, extra] of differing) {
      it(`changes with ${what}`, () => {
        const a = principalState(user());
        const b = principalState(user(extra));
        expect(b).to.be.a('string');
        expect(a).to.not.equal(b);
        expect(key(user())).to.not.equal(key(user(extra)));
      });
    }

    it('ignores identity', () => {
      expect(principalState(user({ identity: { name: 'A', fn: () => 1 } }))).to.equal(principalState(user()));
      expect(principalState(user({ identity: new Map() }))).to.equal(principalState(user()));
    });

    it('ignores the order and duplicates of companions', () => {
      const a = user({
        companions: [
          { type: 'user', id: 'b' },
          { type: 'link', id: 'l' },
        ],
      });
      const b = user({
        companions: [
          { type: 'link', id: 'l' },
          { type: 'user', id: 'b' },
          { type: 'user', id: 'b' },
        ],
      });
      expect(principalState(a)).to.equal(principalState(b));
    });

    it('treats absent companions as [] and absent attributes as {}', () => {
      expect(principalState(user({ companions: undefined }))).to.equal(principalState(user({ companions: [] })));
      expect(principalState(user({ attributes: undefined }))).to.equal(principalState(user({ attributes: {} })));
      expect(principalState(user({ attributes: null }))).to.equal(principalState(user({ attributes: {} })));
    });

    it('sorts mfa but keeps duplicates', () => {
      const mfa = (list: string[]) => user({ authn: { method: 'password', strategy: 'local', assurance: 'aal2', mfa: list, authenticatedAt: new Date(AT) } });
      expect(principalState(mfa(['totp', 'webauthn']))).to.equal(principalState(mfa(['webauthn', 'totp'])));
      expect(principalState(mfa(['totp', 'totp']))).to.not.equal(principalState(mfa(['totp'])));
    });

    it('sorts object keys', () => {
      expect(principalState(user({ attributes: { a: 1, b: 2 } }))).to.equal(principalState(user({ attributes: { b: 2, a: 1 } })));
    });

    it('distinguishes a Date from an object that looks like its encoding', () => {
      const d = principalState(user({ attributes: { x: new Date(AT) } }));
      const o = principalState(user({ attributes: { x: { $date: AT.toISOString() } } }));
      const s = principalState(user({ attributes: { x: AT.toISOString() } }));
      expect(d).to.be.a('string');
      expect(o).to.be.a('string');
      expect(new Set([d, o, s]).size).to.equal(3);
    });

    it('distinguishes $-prefixed keys from each other', () => {
      const a = principalState(user({ attributes: { $date: 'x' } }));
      const b = principalState(user({ attributes: { $$date: 'x' } }));
      expect(a).to.not.equal(b);
    });

    it('distinguishes undefined, null and absent attribute values', () => {
      const states = [{}, { x: null }, { x: undefined }].map((attributes) => principalState(user({ attributes })));
      expect(new Set(states).size).to.equal(3);
      expect(principalState(user({ attributes: { x: [undefined] } }))).to.not.equal(principalState(user({ attributes: { x: [null] } })));
    });

    it('distinguishes "1" from 1 and true from "true"', () => {
      const states = ['1', 1, true, 'true'].map((x) => principalState(user({ attributes: { x } })));
      expect(new Set(states).size).to.equal(4);
    });

    it('writes absent and null contract fields alike', () => {
      expect(principalState(user({ delegation: null }))).to.equal(principalState(user()));
      expect(principalState(user({ onBehalfOf: null }))).to.equal(principalState(user()));
      expect(principalState(user({ ceiling: null }))).to.equal(principalState(user()));
    });

    it('applies the ceilingHash null rule to the ceiling', () => {
      expect(principalState(user({ ceiling: { roles: null, permissions: ['doc:*'] } }))).to.equal(principalState(user({ ceiling: { permissions: ['doc:*'] } })));
      expect(principalState(user({ ceiling: { roles: ['b', 'a'] } }))).to.equal(principalState(user({ ceiling: { roles: ['a', 'b'] } })));
      expect(principalState(user({ ceiling: { expiresAt: new Date(NaN) } }))).to.not.equal(principalState(user({ ceiling: {} })));
    });

    it('distinguishes a delegation chain by every level', () => {
      const deep = (id: string) => user({ onBehalfOf: agent({ onBehalfOf: user({ id }) }) });
      expect(principalState(deep('x'))).to.not.equal(principalState(deep('y')));
    });

    const nonCanonical: [string, () => Principal][] = [
      ['a function attribute', () => user({ attributes: { f: () => 1 } })],
      ['a class instance', () => user({ attributes: { m: new Map() } })],
      ['a symbol', () => user({ attributes: { s: Symbol('x') } })],
      ['a bigint', () => user({ attributes: { b: BigInt(1) } })],
      ['NaN', () => user({ attributes: { n: NaN } })],
      ['Infinity', () => user({ attributes: { n: Infinity } })],
      ['negative zero', () => user({ attributes: { n: -0 } })],
      ['a Date subclass', () => user({ attributes: { d: new (class extends Date {})(0) } })],
      ['a sparse array', () => user({ attributes: { a: [1, , 2] } })], // eslint-disable-line no-sparse-arrays
      ['an array with an extra property', () => user({ attributes: { a: Object.assign([1], { x: 1 }) } })],
      ['a symbol key', () => user({ attributes: { [Symbol('k')]: 1 } })],
      [
        'a throwing getter',
        () =>
          user({
            attributes: Object.defineProperty({}, 'x', {
              enumerable: true,
              get: () => {
                throw new Error('boom');
              },
            }),
          }),
      ],
      ['a getter', () => user({ attributes: Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 }) })],
      ['a top-level getter', () => Object.defineProperty(user(), 'source', { enumerable: true, get: () => 'session' }) as Principal],
      ['a non-string id', () => user({ id: 1 })],
      ['a non-string type', () => user({ type: undefined })],
      ['a malformed companion', () => user({ companions: [{ type: 'user' }] })],
      ['companions not an array', () => user({ companions: { type: 'user', id: 'x' } })],
      ['a malformed impersonator', () => user({ authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(AT), impersonator: 'admin' } })],
      ['a non-Date authenticatedAt', () => user({ authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: AT.toISOString() } })],
      ['a non-string mfa entry', () => user({ authn: { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [1], authenticatedAt: new Date(AT) } })],
      ['a ceiling with a non-string role', () => user({ ceiling: { roles: [1] } })],
      ['a ceiling with a non-Date expiry', () => user({ ceiling: { expiresAt: '2026-01-01' } })],
      ['a ceiling resource with a numeric id', () => user({ ceiling: { resources: [{ type: 'doc', id: 1 }] } })],
      ['a non-object onBehalfOf', () => user({ onBehalfOf: 'u2' })],
      ['a system principal', () => user({ type: 'system' })],
      ['a delegate of type unattended', () => user({ onBehalfOf: agent({ type: 'unattended' }) })],
    ];
    for (const [what, make] of nonCanonical) {
      it(`is undefined for ${what}`, () => {
        expect(principalState(make())).to.equal(undefined);
        expect(key(make())).to.equal(undefined);
      });
    }

    it('is undefined for SYSTEM, UNATTENDED and non-objects', () => {
      expect(principalState(SYSTEM)).to.equal(undefined);
      expect(principalState(UNATTENDED)).to.equal(undefined);
      expect(principalState(null as unknown as Principal)).to.equal(undefined);
      expect(principalState('user:1' as unknown as Principal)).to.equal(undefined);
    });

    it('is undefined for a proxy whose traps throw', () => {
      const p = new Proxy(user(), {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      });
      expect(principalState(p)).to.equal(undefined);
    });

    it('is undefined for cycles', () => {
      const attrs: Record<string, unknown> = {};
      attrs.self = attrs;
      expect(principalState(user({ attributes: attrs }))).to.equal(undefined);

      const a = agent() as unknown as Record<string, unknown>;
      const b = user({ onBehalfOf: a as unknown as Principal });
      a.onBehalfOf = b;
      expect(principalState(b)).to.equal(undefined);
    });

    it('accepts a shared subtree that is not a cycle', () => {
      const shared = { a: 1 };
      expect(principalState(user({ attributes: { x: shared, y: shared } }))).to.equal(principalState(user({ attributes: { x: { a: 1 }, y: { a: 1 } } })));
    });

    it('limits value nesting to 16 levels', () => {
      const nest = (n: number): unknown => (n === 0 ? 1 : { x: nest(n - 1) });
      expect(principalState(user({ attributes: nest(16) as Record<string, unknown> }))).to.be.a('string');
      expect(principalState(user({ attributes: nest(17) as Record<string, unknown> }))).to.equal(undefined);
    });

    it('limits the delegation chain to 8 levels', () => {
      const chain = (n: number): Principal => (n === 0 ? user() : agent({ id: `a${n}`, onBehalfOf: chain(n - 1) }));
      expect(principalState(chain(8))).to.be.a('string');
      expect(principalState(chain(9))).to.equal(undefined);
    });

    it('reads each top-level property once', () => {
      const reads = new Map<PropertyKey, number>();
      const target = user({ companions: [{ type: 'user', id: 'x' }], ceiling: { roles: ['r'] } });
      const p = new Proxy(target, {
        get(t, k, r) {
          reads.set(k, (reads.get(k) ?? 0) + 1);
          return Reflect.get(t, k, r);
        },
        getOwnPropertyDescriptor(t, k) {
          reads.set(k, (reads.get(k) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });
      expect(principalState(p)).to.equal(principalState(target));
      for (const [k, n] of reads) expect(n, String(k)).to.be.at.most(1);
    });

    it('does not mutate the principal', () => {
      const p = user({
        companions: [
          { type: 'user', id: 'b' },
          { type: 'user', id: 'a' },
        ],
        authn: { method: 'p', strategy: 's', assurance: 'aal2', mfa: ['z', 'a'], authenticatedAt: new Date(AT) },
      });
      const before = JSON.stringify(p);
      principalState(p);
      expect(JSON.stringify(p)).to.equal(before);
    });
  });

  describe('decisionKey', () => {
    it('joins the parts with NUL', () => {
      const k = key(user())!;
      const parts = k.split('\u0000');
      expect(parts).to.have.length(6);
      expect(parts[0]).to.equal('default');
      expect(parts[1]).to.equal(principalState(user()));
      expect(parts[2]).to.equal('');
      expect(parts[3]).to.equal('doc:read');
      expect(parts[4]).to.equal('doc:1');
      expect(parts[5]).to.equal('[""]');
    });

    it('differs by every part', () => {
      const base = key(user());
      expect(key(user(), { domain: 'other' })).to.not.equal(base);
      expect(key(user(), { actor: agent() })).to.not.equal(base);
      expect(key(user(), { permission: 'doc:write' })).to.not.equal(base);
      expect(key(user(), { ref: { type: 'doc', id: '2' } })).to.not.equal(base);
      expect(key(user(), { ref: { type: 'doc' } })).to.not.equal(base);
      expect(key(user(), { versions: '["1"]' })).to.not.equal(base);
      expect(key(user(), { actor: agent() })).to.not.equal(key(user(), { actor: agent({ attributes: { x: 1 } }) }));
    });

    it('treats a null id as absent', () => {
      expect(key(user(), { ref: { type: 'doc', id: null } as unknown as ResourceRef })).to.equal(key(user(), { ref: { type: 'doc' } }));
      expect(key(user(), { ref: GLOBAL })).to.be.a('string');
    });

    it('keeps an id with NUL from colliding', () => {
      const a = key(user(), { ref: { type: 'doc', id: 'a\u0000b' } });
      const b = key(user(), { ref: { type: 'doc', id: 'a' } });
      expect(a).to.be.a('string');
      expect(a).to.not.equal(b);
    });

    it('is undefined when any part has no canonical form', () => {
      expect(key(user({ attributes: { f: () => 1 } }))).to.equal(undefined);
      expect(key(user(), { actor: agent({ attributes: { f: () => 1 } }) })).to.equal(undefined);
      expect(key(user(), { ref: { type: 'doc', id: 1 } as unknown as ResourceRef })).to.equal(undefined);
      expect(key(user(), { ref: { type: 1 } as unknown as ResourceRef })).to.equal(undefined);
      expect(decisionKey({ domain: 'd', principal: user(), permission: 'doc:read', ref: null as unknown as ResourceRef, versions: '[]' })).to.equal(undefined);
      expect(key(user(), { permission: 'doc\u0000:read' })).to.equal(undefined);
      expect(key(user(), { permission: 'not a permission' })).to.equal(undefined);
      expect(key(user(), { domain: 'a\u0000b' })).to.equal(undefined);
      expect(key(user(), { versions: '\u0000' })).to.equal(undefined);
      expect(decisionKey({ domain: 'd', principal: user(), permission: 'doc:read', ref: { type: 'doc' }, versions: undefined as unknown as string })).to.equal(undefined);
      expect(decisionKey({ domain: 1 as unknown as string, principal: user(), permission: 'doc:read', ref: { type: 'doc' }, versions: '[]' })).to.equal(undefined);
    });

    it('is undefined for a ref with extra keys or a getter', () => {
      expect(key(user(), { ref: { type: 'doc', id: '1', x: 1 } as unknown as ResourceRef })).to.equal(undefined);
      expect(key(user(), { ref: Object.defineProperty({ type: 'doc' }, 'id', { enumerable: true, get: () => '1' }) as ResourceRef })).to.equal(undefined);
    });
  });

  describe('versionVector', () => {
    it('lists every version in model order', () => {
      expect(versionVector([model('a', () => '1'), model('b'), model('c', () => 'x')])).to.equal('["1","","x"]');
      expect(versionVector([])).to.equal('[]');
    });

    it('changes when a version changes or models reorder', () => {
      expect(versionVector([model('a', () => '1')])).to.not.equal(versionVector([model('a', () => '2')]));
      expect(versionVector([model('a', () => '1'), model('b')])).to.not.equal(versionVector([model('b'), model('a', () => '1')]));
      expect(versionVector([model('a', () => 'x,y')])).to.not.equal(versionVector([model('a', () => 'x'), model('b', () => 'y')]));
    });

    it('calls version with the model as this', () => {
      const m = {
        name: 'm',
        v: '7',
        version(this: { v: string }) {
          return this.v;
        },
      };
      expect(versionVector([m as unknown as AuthorizationModel])).to.equal('["7"]');
    });

    it('is undefined on a throw, a non-string or a non-function version', () => {
      expect(
        versionVector([
          model('a', () => {
            throw new Error('x');
          }),
        ]),
      ).to.equal(undefined);
      expect(versionVector([model('a', () => 1)])).to.equal(undefined);
      expect(versionVector([model('a', () => undefined)])).to.equal(undefined);
      expect(versionVector([model('a', 'v1')])).to.equal(undefined);
      expect(versionVector([null as unknown as AuthorizationModel])).to.equal(undefined);
      expect(versionVector(null as unknown as AuthorizationModel[])).to.equal(undefined);
    });
  });

  describe('entryTags', () => {
    it('tags models, principals, companions, links and ancestors', () => {
      const p = user({ companions: [{ type: 'link', id: 'L1' }] });
      const tags = entryTags({ models: ['rbac', 'abac'], principals: [p, agent()], ref: { type: 'doc', id: '1' }, ancestors: [{ type: 'doc', id: '1' }, { type: 'dir', id: 'd' }, GLOBAL] });
      expect(tags).to.deep.equal(['*', 'link:L1', 'model:abac', 'model:rbac', 'scope:$global', 'scope:dir:d', 'scope:doc:1', 'subject:agent:a1', 'subject:link:L1', 'subject:user:u1'].sort());
      expect(Object.isFrozen(tags)).to.equal(true);
    });

    it('tags a link principal and walks onBehalfOf', () => {
      const link = { type: 'link', id: 'L2', authenticated: true, source: 'link', attributes: {}, onBehalfOf: user() } as unknown as Principal;
      const tags = entryTags({ models: [], principals: [link], ref: { type: 'doc' }, ancestors: undefined })!;
      expect(tags).to.include.members(['link:L2', 'subject:link:L2', 'subject:user:u1', 'scope:*', '*']);
    });

    it('uses scope:* for a ref without id', () => {
      expect(entryTags({ models: ['m'], principals: [user()], ref: { type: 'doc' }, ancestors: [{ type: 'doc' }, GLOBAL] })).to.deep.equal(['*', 'model:m', 'scope:*', 'subject:user:u1']);
    });

    it('always tags the ref itself and deduplicates', () => {
      const tags = entryTags({ models: ['m', 'm'], principals: [user(), user()], ref: { type: 'doc', id: '1' }, ancestors: [GLOBAL] });
      expect(tags).to.deep.equal(['*', 'model:m', 'scope:$global', 'scope:doc:1', 'subject:user:u1']);
    });

    it('is undefined when a tag cannot be built', () => {
      expect(entryTags({ models: ['m'], principals: [user()], ref: { type: 'doc', id: '1' }, ancestors: undefined })).to.equal(undefined);
      expect(entryTags({ models: [1 as unknown as string], principals: [user()], ref: { type: 'doc' }, ancestors: undefined })).to.equal(undefined);
      expect(entryTags({ models: [], principals: [{ type: 'user' } as unknown as Principal], ref: { type: 'doc' }, ancestors: undefined })).to.equal(undefined);
      expect(entryTags({ models: [], principals: [user({ companions: [{ id: 'x' }] })], ref: { type: 'doc' }, ancestors: undefined })).to.equal(undefined);
      expect(entryTags({ models: [], principals: [user()], ref: { type: 'doc', id: '1' }, ancestors: [{ type: 1 } as unknown as ResourceRef] })).to.equal(undefined);
    });
  });

  describe('invalidationTags', () => {
    it('maps tags', () => {
      expect(invalidationTags(['subject:user:1', 'link:L', 'model:rbac'])).to.deep.equal(['link:L', 'model:rbac', 'subject:user:1']);
      expect(invalidationTags(['scope:doc:1'])).to.deep.equal(['scope:*', 'scope:doc:1']);
      expect(invalidationTags(['role:admin'])).to.deep.equal(['*']);
      expect(invalidationTags(['policy:p', 'rule:r', 'whatever', 'subject:user:1'])).to.deep.equal(['*', 'subject:user:1']);
      expect(invalidationTags(['*'])).to.deep.equal(['*']);
      expect(invalidationTags([])).to.deep.equal([]);
    });

    it('fails wide on malformed input', () => {
      expect(invalidationTags([1 as unknown as string])).to.deep.equal(['*']);
      expect(invalidationTags(null as unknown as string[])).to.deep.equal(['*']);
    });

    it('returns a frozen copy', () => {
      const input = ['scope:x'];
      const out = invalidationTags(input);
      expect(Object.isFrozen(out)).to.equal(true);
      expect(input).to.deep.equal(['scope:x']);
    });
  });

  describe('review fixes', () => {
    it('keeps own __proto__ keys in attributes, nested values and rest', () => {
      const plain = principalState(user({ attributes: {} }));
      const polluted = principalState(user({ attributes: JSON.parse('{"__proto__":{"role":"admin"}}') }));
      const scalarProto = principalState(user({ attributes: JSON.parse('{"__proto__":"x"}') }));
      expect(polluted).to.be.a('string');
      expect(scalarProto).to.be.a('string');
      expect(new Set([plain, polluted, scalarProto]).size).to.equal(3);

      const nested = principalState(user({ attributes: { a: JSON.parse('{"__proto__":{"role":"admin"}}') } }));
      expect(nested).to.be.a('string');
      expect(nested).to.not.equal(principalState(user({ attributes: { a: {} } })));

      const top = JSON.parse(JSON.stringify(user()).replace('{', '{"__proto__":{"role":"admin"},'));
      top.authn.authenticatedAt = new Date(AT);
      expect(principalState(top)).to.be.a('string');
      expect(principalState(top)).to.not.equal(principalState(user()));

      const authn = JSON.parse(JSON.stringify((user() as unknown as { authn: object }).authn).replace('{', '{"__proto__":"x",'));
      authn.authenticatedAt = new Date(AT);
      expect(principalState(user({ authn }))).to.be.a('string');
      expect(principalState(user({ authn }))).to.not.equal(principalState(user()));
    });

    it('is undefined when shared subtrees exceed the value budget', () => {
      let node: unknown = 1;
      for (let level = 0; level < 8; level++) {
        const next: Record<string, unknown> = {};
        for (let k = 0; k < 8; k++) next[`k${k}`] = node;
        node = next;
      }
      const started = Date.now();
      expect(principalState(user({ attributes: { dag: node } }))).to.equal(undefined);
      expect(Date.now() - started).to.be.below(5000);
    });

    it('is undefined for a large flat value and for a huge companion list', () => {
      const wide: Record<string, number> = {};
      for (let i = 0; i < 20000; i++) wide[`k${i}`] = i;
      expect(principalState(user({ attributes: wide }))).to.equal(undefined);
      const list = Array.from({ length: 20000 }, (_, i) => ({ type: 'user', id: String(i) }));
      expect(principalState(user({ companions: list }))).to.equal(undefined);
    });

    it('accepts values within the budget', () => {
      const wide: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) wide[`k${i}`] = i;
      expect(principalState(user({ attributes: wide }))).to.be.a('string');
    });

    it('caps the length of a state and of a key at 64 KB', () => {
      expect(principalState(user({ attributes: { big: 'x'.repeat(70 * 1024) } }))).to.equal(undefined);
      expect(principalState(user({ attributes: { big: 'x'.repeat(60 * 1024) } }))).to.be.a('string');
      const half = user({ attributes: { big: 'x'.repeat(40 * 1024) } });
      expect(key(half)).to.be.a('string');
      expect(key(half, { actor: agent({ attributes: { big: 'y'.repeat(40 * 1024) } }) })).to.equal(undefined);
      expect(key(user(), { ref: { type: 'doc', id: 'x'.repeat(70 * 1024) } })).to.equal(undefined);
    });

    it('rejects a principal, authn or ceiling with a class prototype', () => {
      class P {
        get isAdmin() {
          return true;
        }
      }
      expect(principalState(Object.assign(new P(), user()) as unknown as Principal)).to.equal(undefined);
      const authn = Object.assign(Object.create({ extra: 1 }), (user() as unknown as { authn: object }).authn);
      expect(principalState(user({ authn }))).to.equal(undefined);
      expect(principalState(user({ ceiling: Object.create({ roles: ['x'] }) }))).to.equal(undefined);
      expect(principalState(Object.assign(Object.create(null), user()))).to.be.a('string');
    });

    it('is undefined for a proxy that lists a key it has no descriptor for', () => {
      const p = new Proxy(user() as object, {
        ownKeys: (t) => [...Reflect.ownKeys(t), 'ghost'],
        getOwnPropertyDescriptor: (t, k) => Reflect.getOwnPropertyDescriptor(t, k),
      });
      expect(principalState(p as Principal)).to.equal(undefined);
    });
  });

  describe('properties', () => {
    // Tagged tuples: an independent encoding of what the engine may observe.
    const oracleValue = (v: unknown): unknown => {
      if (v === undefined) return ['u'];
      if (v === null) return ['null'];
      if (v instanceof Date) return ['d', Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()];
      if (Array.isArray(v)) return ['a', v.map(oracleValue)];
      if (typeof v === 'object')
        return [
          'o',
          Object.keys(v)
            .sort()
            .map((k) => [k, oracleValue((v as Record<string, unknown>)[k])]),
        ];
      return [typeof v, v];
    };
    const keyOf = (r: { type: string; id: string }) => `${r.type}:${r.id}`;
    const set = (v: unknown, f: (x: never) => string = String) => (v == null ? null : [...new Set((v as never[]).map(f))].sort());
    const time = (v: unknown) => (v == null ? null : Number.isNaN((v as Date).getTime()) ? 'invalid' : (v as Date).toISOString());
    const oracle = (p: Record<string, unknown> | undefined | null): unknown => {
      if (p == null) return null;
      const authn = p.authn as Record<string, unknown> | undefined;
      const ceiling = p.ceiling as Record<string, unknown> | undefined;
      return [p.type, p.id, p.authenticated ?? null, p.source ?? null, p.delegation ?? null, oracle(p.onBehalfOf as Record<string, unknown> | undefined), set(p.companions ?? [], keyOf), oracleValue(p.attributes ?? {}), authn == null ? null : [authn.method, authn.strategy, authn.assurance, [...(authn.mfa as string[])].sort(), time(authn.authenticatedAt), authn.impersonator ? keyOf(authn.impersonator as { type: string; id: string }) : null, authn.sessionHandle ?? null], ceiling == null ? null : [set(ceiling.roles), set(ceiling.permissions), set(ceiling.resources, keyOf), time(ceiling.expiresAt)], Object.hasOwn(p, 'tenant') ? oracleValue(p.tenant) : 'absent'];
    };

    // Built with defineProperty: a '__proto__' key stays an own key, as JSON.parse leaves it.
    const dict = <T>(keys: fc.Arbitrary<string>, values: fc.Arbitrary<T>) =>
      fc.uniqueArray(fc.tuple(keys, values), { maxLength: 2, selector: ([k]) => k }).map((entries) => {
        const o: Record<string, T> = {};
        for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        return o;
      });
    const ids = fc.constantFrom('1', '2');
    const ref = fc.record({ type: fc.constantFrom('user', 'link'), id: ids });
    const scalar = fc.constantFrom<unknown>(0, 1, '1', 'a', true, null, undefined, new Date(0), new Date(1));
    const attrValue = fc.oneof(scalar, fc.array(scalar, { maxLength: 2 }), dict(fc.constantFrom('a', '$date', '$$date', '__proto__'), scalar));
    const authn = fc.record(
      {
        method: fc.constant('password'),
        strategy: fc.constantFrom('local', 'oidc'),
        assurance: fc.constantFrom('aal1', 'aal2'),
        mfa: fc.array(fc.constantFrom('totp', 'sms'), { maxLength: 2 }),
        authenticatedAt: fc.constantFrom(0, 1000).map((t) => new Date(t)),
        impersonator: fc.option(ref, { nil: undefined }),
        sessionHandle: fc.constantFrom('h1', 'h2'),
      },
      { requiredKeys: ['method', 'strategy', 'assurance', 'mfa', 'authenticatedAt'] },
    );
    const ceiling = fc.record(
      {
        roles: fc.array(fc.constantFrom('r1', 'r2'), { maxLength: 2 }),
        permissions: fc.array(fc.constantFrom('doc:*', 'doc:read'), { maxLength: 2 }),
        resources: fc.array(fc.record({ type: fc.constantFrom('doc', 'dir'), id: ids }), { maxLength: 2 }),
        expiresAt: fc.constantFrom(0, 1000, NaN).map((t) => new Date(t)),
      },
      { requiredKeys: [] },
    );
    const base = {
      type: fc.constantFrom('user', 'agent', 'link'),
      id: ids,
      authenticated: fc.boolean(),
      source: fc.constantFrom('session', 'token'),
      delegation: fc.constantFrom('intersect', 'inherit'),
      companions: fc.array(ref, { maxLength: 3 }),
      attributes: dict(fc.constantFrom('a', 'b', '$date', '__proto__'), attrValue),
      authn,
      ceiling,
      tenant: fc.constantFrom<unknown>('t1', 1, null, { __x: 1 }),
    };
    const principalArb = fc.letrec((tie) => ({
      p: fc.record({ ...base, onBehalfOf: fc.oneof({ maxDepth: 2, depthIdentifier: 'obo' }, fc.constant(undefined), tie('p')) }, { requiredKeys: ['type', 'id', 'authenticated', 'source'] }),
    })).p;

    const strip = (p: unknown): Record<string, unknown> => {
      const o = { ...(p as Record<string, unknown>) };
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
      if (o.onBehalfOf) o.onBehalfOf = strip(o.onBehalfOf);
      return o;
    };

    // Same canonical data, different spelling: shuffled keys and companions, duplicated companions, null for absent.
    const respell = (p: Record<string, unknown>): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(p).reverse()) o[k] = p[k];
      if (Array.isArray(o.companions)) o.companions = [...o.companions].reverse().concat(o.companions.slice(0, 1));
      for (const k of ['delegation', 'ceiling', 'authn', 'onBehalfOf']) if (!(k in o)) o[k] = null;
      if (o.onBehalfOf) o.onBehalfOf = respell(o.onBehalfOf as Record<string, unknown>);
      return o;
    };

    it('principalState is injective on canonical data', () => {
      let equalPairs = 0;
      let differentPairs = 0;
      fc.assert(
        fc.property(principalArb, principalArb, fc.boolean(), (ra, rb, same) => {
          const a = strip(ra);
          const b = same ? respell(a) : strip(rb);
          const sameData = JSON.stringify(oracle(a)) === JSON.stringify(oracle(b));
          const sa = principalState(a as unknown as Principal);
          const sb = principalState(b as unknown as Principal);
          expect(sa).to.be.a('string');
          expect(sb).to.be.a('string');
          if (sameData) equalPairs++;
          else differentPairs++;
          expect(sa === sb).to.equal(sameData);
        }),
        { numRuns: 2000 },
      );
      expect(equalPairs).to.be.greaterThan(100);
      expect(differentPairs).to.be.greaterThan(100);
    });

    it('a structural copy always has the same state', () => {
      const copy = (v: unknown): unknown =>
        v instanceof Date
          ? new Date(v.getTime())
          : Array.isArray(v)
          ? v.map(copy)
          : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, copy(x)]),
            )
          : v;
      fc.assert(
        fc.property(principalArb, (ra) => {
          const a = strip(ra);
          expect(principalState(copy(a) as Principal)).to.equal(principalState(a as unknown as Principal));
        }),
        { numRuns: 500 },
      );
    });
  });
});
