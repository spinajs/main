import * as chai from 'chai';
import 'mocha';

import { NO_CEILING, ceilingOutcome, mergeCeilings, readCeiling, scopeCovers } from '../../src/engine/ceiling.js';
import type { CeilingOutcome } from '../../src/engine/ceiling.js';
import { FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { ResourceRef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-02T12:00:00.000Z');
const DOC: ResourceRef = Object.freeze({ type: 'doc', id: 'd1' });
const DOC_TYPE: ResourceRef = Object.freeze({ type: 'doc' });
const DOC_ANCESTORS: readonly ResourceRef[] = Object.freeze([DOC, { type: 'folder', id: 'f1' }, { type: 'org', id: 'o1' }, GLOBAL]);

const outcome = (ceiling: unknown, o: { permission?: string; ref?: ResourceRef; ancestors?: readonly ResourceRef[]; now?: Date } = {}): CeilingOutcome => ceilingOutcome(ceiling, o.permission ?? 'doc:read', o.ref ?? DOC, 'ancestors' in o ? o.ancestors : DOC_ANCESTORS, o.now ?? NOW);

const denied = (o: CeilingOutcome, code = 'ceiling') => {
  expect(o.denials.length).to.be.greaterThan(0);
  for (const d of o.denials) expect(d).to.deep.equal({ code, priority: 200 });
  expect(o.restrict).to.equal(FALSE);
};

const passes = (o: CeilingOutcome) => {
  expect(o.denials).to.deep.equal([]);
  expect(o.restrict).to.equal(TRUE);
};

describe('engine/ceiling', () => {
  describe('absent and malformed ceilings', () => {
    it('undefined and null are no ceiling', () => {
      expect(outcome(undefined)).to.equal(NO_CEILING);
      expect(outcome(null)).to.equal(NO_CEILING);
      passes(NO_CEILING);
      expect(NO_CEILING.expiresAt).to.equal(undefined);
      expect(Object.isFrozen(NO_CEILING)).to.equal(true);
      expect(Object.isFrozen(NO_CEILING.denials)).to.equal(true);
    });

    it('an empty object restricts nothing', () => {
      passes(outcome({}));
    });

    it('null fields count as absent', () => {
      passes(outcome({ roles: null, permissions: null, resources: null, expiresAt: null, reason: null }));
    });

    for (const [name, value] of [
      ['a string', 'ceiling'],
      ['a number', 1],
      ['true', true],
      ['a function', () => ({})],
      ['an array', []],
    ] as const) {
      it(`a ceiling that is ${name} denies`, () => {
        denied(outcome(value));
      });
    }

    for (const [name, value] of [
      ['permissions not an array', { permissions: 'doc:*' }],
      ['permissions with a number', { permissions: ['doc:*', 3] }],
      ['permissions with a hole', { permissions: [, 'doc:*'] }], // eslint-disable-line no-sparse-arrays
      ['roles not an array', { roles: 'admin' }],
      ['roles with a non-string', { roles: ['admin', {}] }],
      ['resources not an array', { resources: { type: 'doc' } }],
      ['resources with a string', { resources: ['doc:d1'] }],
      ['resources with an empty type', { resources: [{ type: '' }] }],
      ['resources with a numeric id', { resources: [{ type: 'doc', id: 1 }] }],
      ['resources with null', { resources: [null] }],
      ['expiresAt a string', { expiresAt: '2030-01-01T00:00:00Z' }],
      ['expiresAt a number', { expiresAt: Date.parse('2030-01-01T00:00:00Z') }],
      ['expiresAt a fake Date', { expiresAt: Object.create(Date.prototype) }],
      ['reason a number', { reason: 7 }],
      ['reason empty', { reason: '' }],
    ] as const) {
      it(`a malformed field (${name}) denies with code ceiling, never the custom reason`, () => {
        denied(outcome({ ...(value as object), reason: (value as { reason?: unknown }).reason ?? undefined }));
        if (!('reason' in value)) denied(outcome({ ...(value as object), reason: 'custom' }));
      });
    }

    it('a getter that throws denies', () => {
      const c = {
        get permissions(): string[] {
          throw new Error('boom');
        },
      };
      denied(outcome(c));
    });

    it('a proxy that throws on any read denies', () => {
      const p = new Proxy(
        {},
        {
          get() {
            throw new Error('trap');
          },
        },
      );
      denied(outcome(p));
    });

    it('reads every field once', () => {
      const reads: Record<string, number> = {};
      const c = new Proxy({ permissions: ['doc:*'], roles: ['viewer'], resources: [{ type: 'folder', id: 'f1' }], expiresAt: new Date('2030-01-01T00:00:00Z'), reason: 'agents_disabled' } as Record<string, unknown>, {
        get(target, key) {
          if (typeof key === 'string') reads[key] = (reads[key] ?? 0) + 1;
          return target[key as string];
        },
      });
      passes(outcome(c));
      for (const k of ['permissions', 'roles', 'resources', 'expiresAt', 'reason']) expect(reads[k], k).to.equal(1);
    });

    it('a field that changes between reads cannot widen: the list is copied once', () => {
      let n = 0;
      const list = new Proxy(['doc:write'], {
        get(target, key) {
          if (key === '0') return n++ === 0 ? 'doc:write' : 'doc:read';
          return Reflect.get(target, key);
        },
      });
      denied(outcome({ permissions: list }));
    });

    it('refuses an absurdly long list', () => {
      const permissions = new Array<string>(10_001).fill('doc:read');
      denied(outcome({ permissions }));
    });

    it('does not mutate or freeze its input', () => {
      const c = { permissions: ['doc:*'], resources: [{ type: 'folder', id: 'f1' }], expiresAt: new Date('2030-01-01T00:00:00Z') };
      outcome(c);
      expect(Object.isFrozen(c)).to.equal(false);
      expect(Object.isFrozen(c.permissions)).to.equal(false);
      expect(Object.isFrozen(c.resources[0])).to.equal(false);
    });
  });

  describe('permissions', () => {
    it('allows when a glob matches exactly', () => {
      passes(outcome({ permissions: ['doc:read'] }));
      passes(outcome({ permissions: ['doc:*'] }));
      passes(outcome({ permissions: ['*'] }));
      passes(outcome({ permissions: ['file:*', 'd*:r*'] }));
    });

    it('denies when no glob matches, with the custom reason', () => {
      denied(outcome({ permissions: ['doc:write'], reason: 'agents_disabled' }), 'agents_disabled');
      denied(outcome({ permissions: ['file:*'] }));
    });

    it('[] covers nothing', () => {
      denied(outcome({ permissions: [] }));
    });

    it('an invalid glob matches nothing (and does not throw)', () => {
      denied(outcome({ permissions: ['doc:**'] }));
      denied(outcome({ permissions: ['doc'] }));
      denied(outcome({ permissions: [''] }));
      passes(outcome({ permissions: ['doc:**', 'doc:read'] }));
    });

    it('does not follow implies', () => {
      denied(outcome({ permissions: ['doc:write'] }, { permission: 'doc:stat' }));
    });

    it('an invalid permission name matches nothing', () => {
      denied(outcome({ permissions: ['*'] }, { permission: 'not a name' }));
    });
  });

  describe('expiresAt', () => {
    const at = new Date('2026-10-02T13:00:00.000Z');

    it('passes before the instant and reports expiresAt as a copy', () => {
      const o = outcome({ expiresAt: at });
      passes(o);
      expect(o.expiresAt?.getTime()).to.equal(at.getTime());
      expect(o.expiresAt).to.not.equal(at);
    });

    it('denies at the exact instant', () => {
      denied(outcome({ expiresAt: at }, { now: new Date(at.getTime()) }));
    });

    it('passes one millisecond before', () => {
      passes(outcome({ expiresAt: at }, { now: new Date(at.getTime() - 1) }));
    });

    it('denies after the instant, with the custom reason', () => {
      denied(outcome({ expiresAt: at, reason: 'expired_grant' }, { now: new Date(at.getTime() + 1) }), 'expired_grant');
    });

    it('denies an invalid date and reports no expiresAt', () => {
      const o = outcome({ expiresAt: new Date('nope') });
      denied(o);
      expect(o.expiresAt).to.equal(undefined);
    });

    it('denies when now itself is invalid', () => {
      denied(outcome({ expiresAt: at }, { now: new Date(NaN) }));
    });

    it('a later setTime on the input does not move the reported expiry', () => {
      const d = new Date(at.getTime());
      const o = outcome({ expiresAt: d });
      d.setTime(at.getTime() + 1_000_000);
      expect(o.expiresAt?.getTime()).to.equal(at.getTime());
    });
  });

  describe('resources, ref with an id', () => {
    it('allows when an ancestor is covered', () => {
      passes(outcome({ resources: [{ type: 'folder', id: 'f1' }] }));
      passes(outcome({ resources: [{ type: 'org' }] }));
      passes(outcome({ resources: [GLOBAL] }));
      passes(outcome({ resources: [{ type: 'doc', id: 'd1' }] }));
      passes(outcome({ resources: [{ type: 'folder', id: null }] }));
    });

    it('the ref covers itself even when the ancestor list leaves it out', () => {
      passes(outcome({ resources: [{ type: 'doc', id: 'd1' }] }, { ancestors: [GLOBAL] }));
    });

    it('denies when nothing is covered', () => {
      denied(outcome({ resources: [{ type: 'folder', id: 'f2' }] }));
      denied(outcome({ resources: [{ type: 'project' }] }));
      denied(outcome({ resources: [{ type: 'doc', id: 'd2' }], reason: 'out_of_scope' }), 'out_of_scope');
    });

    it('[] covers nothing', () => {
      denied(outcome({ resources: [] }));
    });

    it('a GLOBAL entry covers only what reports GLOBAL among its ancestors', () => {
      denied(outcome({ resources: [GLOBAL] }, { ancestors: [DOC] }));
    });

    it('a $global entry with an id is not GLOBAL', () => {
      denied(outcome({ resources: [{ type: '$global', id: 'x' }] }));
    });

    it('missing ancestors deny (fail closed)', () => {
      denied(outcome({ resources: [{ type: 'folder', id: 'f1' }] }, { ancestors: undefined }));
    });

    it('malformed ancestors are skipped, never matched', () => {
      denied(outcome({ resources: [{ type: 'folder', id: 'f1' }] }, { ancestors: [null as unknown as ResourceRef, { type: 'folder', id: 7 } as unknown as ResourceRef] }));
    });

    it('a ref with id null is type-level', () => {
      const o = outcome({ resources: [{ type: 'folder', id: 'f1' }] }, { ref: { type: 'doc', id: null } as unknown as ResourceRef, ancestors: undefined });
      expect(o.denials).to.deep.equal([]);
      expect(o.restrict).to.deep.equal({ op: 'under', scopes: [{ type: 'folder', id: 'f1' }] });
    });
  });

  describe('resources, type-level ref', () => {
    it('restricts the allow with under(resources)', () => {
      const o = outcome(
        {
          resources: [
            { type: 'folder', id: 'f1' },
            { type: 'org', id: null },
          ],
        },
        { ref: DOC_TYPE, ancestors: undefined },
      );
      expect(o.denials).to.deep.equal([]);
      expect(o.restrict).to.deep.equal({ op: 'under', scopes: [{ type: 'folder', id: 'f1' }, { type: 'org' }] });
      expect(Object.isFrozen(o.restrict)).to.equal(true);
      expect(Object.isFrozen((o.restrict as { scopes: readonly ResourceRef[] }).scopes)).to.equal(true);
      expect(Object.isFrozen((o.restrict as { scopes: readonly ResourceRef[] }).scopes[0])).to.equal(true);
    });

    it('ignores the ancestors argument', () => {
      const o = outcome({ resources: [{ type: 'folder', id: 'f1' }] }, { ref: DOC_TYPE, ancestors: [{ type: 'folder', id: 'f1' }] });
      expect(o.restrict).to.deep.equal({ op: 'under', scopes: [{ type: 'folder', id: 'f1' }] });
    });

    it('a GLOBAL entry lifts the restriction', () => {
      passes(outcome({ resources: [{ type: 'folder', id: 'f1' }, GLOBAL] }, { ref: DOC_TYPE }));
    });

    it('a type-level entry of the own type lifts the restriction', () => {
      passes(outcome({ resources: [{ type: 'doc' }] }, { ref: DOC_TYPE }));
      passes(outcome({ resources: [{ type: 'doc', id: null }] }, { ref: DOC_TYPE }));
    });

    it('an entry of the own type with an id still restricts', () => {
      const o = outcome({ resources: [{ type: 'doc', id: 'd1' }] }, { ref: DOC_TYPE });
      expect(o.restrict).to.deep.equal({ op: 'under', scopes: [{ type: 'doc', id: 'd1' }] });
    });

    it('[] covers nothing', () => {
      denied(outcome({ resources: [] }, { ref: DOC_TYPE }));
    });
  });

  describe('resources, GLOBAL ref (a single node, decided statically)', () => {
    it('a GLOBAL entry passes', () => {
      passes(outcome({ resources: [GLOBAL] }, { ref: GLOBAL, ancestors: undefined }));
      passes(
        outcome(
          {
            resources: [
              { type: '$global', id: null },
              { type: 'org', id: 'o1' },
            ],
          },
          { ref: GLOBAL },
        ),
      );
    });

    it('any other entry denies instead of restricting', () => {
      denied(outcome({ resources: [{ type: 'org', id: 'o1' }], reason: 'out_of_scope' }, { ref: GLOBAL, ancestors: undefined }), 'out_of_scope');
      denied(outcome({ resources: [{ type: 'org' }] }, { ref: GLOBAL }));
      denied(outcome({ resources: [{ type: '$global', id: 'x' }] }, { ref: GLOBAL }));
      denied(outcome({ resources: [] }, { ref: GLOBAL }));
    });

    it('ignores the ancestors argument', () => {
      denied(outcome({ resources: [{ type: 'org', id: 'o1' }] }, { ref: GLOBAL, ancestors: [{ type: 'org', id: 'o1' }] }));
    });
  });

  describe('combined parts', () => {
    it('any failing part denies; the restriction is dropped to FALSE', () => {
      const o = outcome({ permissions: ['doc:write'], resources: [{ type: 'folder', id: 'f1' }] }, { ref: DOC_TYPE });
      denied(o);
    });

    it('all parts pass', () => {
      const o = outcome({ permissions: ['doc:*'], roles: ['viewer'], resources: [{ type: 'folder', id: 'f1' }], expiresAt: new Date('2030-01-01T00:00:00Z'), reason: 'x' });
      passes(o);
      expect(o.expiresAt?.toISOString()).to.equal('2030-01-01T00:00:00.000Z');
    });

    it('an expired ceiling still reports its expiry', () => {
      const o = outcome({ expiresAt: new Date('2020-01-01T00:00:00Z') });
      denied(o);
      expect(o.expiresAt?.toISOString()).to.equal('2020-01-01T00:00:00.000Z');
    });

    it('the outcome is frozen', () => {
      const o = outcome({ permissions: [] });
      expect(Object.isFrozen(o)).to.equal(true);
      expect(Object.isFrozen(o.denials)).to.equal(true);
      expect(Object.isFrozen(o.denials[0])).to.equal(true);
    });
  });

  describe('mergeCeilings', () => {
    it('no outcomes is no ceiling', () => {
      passes(mergeCeilings([]));
    });

    it('concatenates denials, ANDs restrictions and keeps the earliest expiry', () => {
      const a = outcome({ resources: [{ type: 'folder', id: 'f1' }], expiresAt: new Date('2030-01-01T00:00:00Z') }, { ref: DOC_TYPE });
      const b = outcome({ resources: [{ type: 'org', id: 'o1' }], expiresAt: new Date('2029-01-01T00:00:00Z') }, { ref: DOC_TYPE });
      const m = mergeCeilings([a, b, NO_CEILING]);
      expect(m.denials).to.deep.equal([]);
      expect(m.restrict).to.deep.equal({ op: 'and', args: [a.restrict, b.restrict] });
      expect(m.expiresAt?.toISOString()).to.equal('2029-01-01T00:00:00.000Z');
      expect(Object.isFrozen(m)).to.equal(true);
    });

    it('one denial denies the merge', () => {
      const m = mergeCeilings([outcome({}), outcome({ permissions: [], reason: 'agents_disabled' }), outcome({ resources: [] })]);
      expect(m.denials).to.deep.equal([
        { code: 'agents_disabled', priority: 200 },
        { code: 'ceiling', priority: 200 },
      ]);
      expect(m.restrict).to.equal(FALSE);
    });

    it('a denial forces FALSE even when a hand-made outcome left restrict TRUE', () => {
      const m = mergeCeilings([{ denials: [{ code: 'ceiling', priority: 200 }], restrict: TRUE }]);
      expect(m.restrict).to.equal(FALSE);
    });

    it('a non-array input denies', () => {
      denied(mergeCeilings(undefined as unknown as CeilingOutcome[]));
    });
  });

  describe('scopeCovers', () => {
    it('same type, scope without id', () => {
      expect(scopeCovers({ type: 'org' }, { type: 'org', id: 'o1' })).to.equal(true);
      expect(scopeCovers({ type: 'org', id: null } as unknown as ResourceRef, { type: 'org', id: 'o1' })).to.equal(true);
      expect(scopeCovers({ type: 'org' }, { type: 'org' })).to.equal(true);
    });

    it('same type and id', () => {
      expect(scopeCovers({ type: 'org', id: 'o1' }, { type: 'org', id: 'o1' })).to.equal(true);
      expect(scopeCovers({ type: 'org', id: 'o1' }, { type: 'org', id: 'o2' })).to.equal(false);
    });

    it('a scope with id does not cover a node without one', () => {
      expect(scopeCovers({ type: 'org', id: 'o1' }, { type: 'org' })).to.equal(false);
      expect(scopeCovers({ type: 'org', id: 'o1' }, { type: 'org', id: null } as unknown as ResourceRef)).to.equal(false);
    });

    it('other types never match', () => {
      expect(scopeCovers({ type: 'org' }, { type: 'folder', id: 'o1' })).to.equal(false);
    });

    it('malformed input never matches', () => {
      expect(scopeCovers(null as unknown as ResourceRef, { type: 'org' })).to.equal(false);
      expect(scopeCovers({} as ResourceRef, {} as ResourceRef)).to.equal(false);
      expect(scopeCovers({ type: 'org', id: 1 } as unknown as ResourceRef, { type: 'org', id: 1 } as unknown as ResourceRef)).to.equal(false);
      const throwing = {
        get type(): string {
          throw new Error('x');
        },
      } as ResourceRef;
      expect(scopeCovers(throwing, { type: 'org' })).to.equal(false);
    });
  });

  describe('readCeiling', () => {
    it('returns a frozen validated copy without null fields', () => {
      const r = readCeiling({ roles: ['viewer'], permissions: null, resources: [{ type: 'org', id: null, extra: 1 }], reason: 'x' });
      expect(r).to.deep.equal({ ok: true, ceiling: { roles: ['viewer'], resources: [{ type: 'org' }], reason: 'x' } });
      if (r.ok) {
        expect(Object.isFrozen(r.ceiling)).to.equal(true);
        expect(Object.isFrozen(r.ceiling!.roles)).to.equal(true);
      }
    });

    it('absent is ok without a ceiling; malformed is not ok', () => {
      expect(readCeiling(undefined)).to.deep.equal({ ok: true });
      expect(readCeiling(null)).to.deep.equal({ ok: true });
      expect(readCeiling({ roles: 'x' })).to.deep.equal({ ok: false });
    });
  });
});
