import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';
import { AuthenticationFailed, Exception, Forbidden } from '@spinajs/exceptions';

import * as root from '../../src/index.js';
import { DEFAULT_DENY_PRIORITY, UNKNOWN_DENY_PRIORITY, denyPriority, compareDenyReasons } from '../../src/contracts/decision.js';
import { AccessDenied, Unauthenticated, NeedsAsync } from '../../src/contracts/errors.js';
import { FALSE, TRUE } from '../../src/contracts/filter.js';
import type { CombiningAlgorithm, Decision, DecisionRequest, DenyReason, FieldSet, Trace, TraceStep, Vote } from '../../src/contracts/decision.js';
import type { Principal } from '../../src/contracts/principal.js';

const expect = chai.expect;

const principal = { type: 'user', id: 'u1' } as unknown as Principal;

const step: TraceStep = { by: 'core', step: 'route', note: 'routed', data: { n: 1 } };

const vote: Vote = {
  model: 'rbac',
  permitWhen: TRUE,
  denyWhen: FALSE,
  denies: [{ when: FALSE, reason: { code: 'no_access', model: 'rbac' } }],
  error: undefined,
  reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' },
  roles: { project: 'viewer' },
  fields: { read: ['*'], hide: ['secret'] } satisfies FieldSet,
  validUntil: new Date(0),
  cacheable: true,
  trace: [step],
};

const decision: Decision = {
  allowed: true,
  permission: 'doc.read',
  resource: { type: 'doc', id: '1' },
  principal: { type: 'user', id: 'u1' },
  actor: { type: 'agent', id: 'a1' },
  residual: TRUE,
  fields: { read: ['*'], write: [] },
  roles: { project: 'viewer' },
  reason: { code: 'no_access' },
  validUntil: new Date(0),
  domain: 'default',
  trace: {
    domain: 'default',
    algorithm: 'deny-overrides' satisfies CombiningAlgorithm,
    models: ['rbac'],
    votes: [vote],
    steps: [step],
    durationMs: 1,
  } satisfies Trace,
};

const request: DecisionRequest = {
  principal,
  actor: principal,
  permission: 'doc.read',
  resource: { type: 'doc' },
  subject: { a: 1 },
  env: { ip: '127.0.0.1' },
  explain: true,
};

const reason = (code: string, extra: Partial<DenyReason> = {}): DenyReason => ({ code, ...extra });

describe('decision contracts', () => {
  describe('types', () => {
    it('accepts full literals and minimal ones', () => {
      expect(vote.cacheable).to.eq(true);
      expect(decision.trace?.votes).to.have.length(1);
      expect(request.permission).to.eq('doc.read');
      const minimal: Vote = { model: 'm', permitWhen: FALSE, denyWhen: FALSE, cacheable: false };
      expect(minimal.model).to.eq('m');
    });

    it('rejects wrong shapes', () => {
      // @ts-expect-error cacheable is required
      const noCacheable: Vote = { model: 'm', permitWhen: FALSE, denyWhen: FALSE };
      // @ts-expect-error roles is required
      const noRoles: Decision = { allowed: true, permission: 'a.b', resource: { type: 'a' }, principal: { type: 'user', id: '1' }, residual: TRUE, fields: { read: [], write: [] }, domain: 'd' };
      // @ts-expect-error domain is required
      const noDomain: Decision = { allowed: true, permission: 'a.b', resource: { type: 'a' }, principal: { type: 'user', id: '1' }, residual: TRUE, fields: { read: [], write: [] }, roles: {} };
      // @ts-expect-error code is required
      const noCode: DenyReason = { model: 'm' };
      expect([noCacheable, noRoles, noDomain, noCode]).to.have.length(4);
    });

    it('keeps members readonly', () => {
      // Never called: the compiler checks the assignments, the shared fixtures stay untouched.
      const assignAll = (): void => {
        // @ts-expect-error readonly
        vote.model = 'x';
        // @ts-expect-error readonly
        decision.allowed = false;
        // @ts-expect-error readonly
        decision.fields.read = [];
        // @ts-expect-error readonly
        request.explain = false;
        // @ts-expect-error readonly
        step.note = 'x';
      };
      expect(assignAll).to.be.a('function');
    });

    it('allows extra keys on DenyReason', () => {
      const r: DenyReason = { code: 'tag_missing', tag: 'x' };
      expect(r.tag).to.eq('x');
    });
  });

  describe('DEFAULT_DENY_PRIORITY', () => {
    it('holds the table', () => {
      expect({ ...DEFAULT_DENY_PRIORITY }).to.deep.eq({
        unknown_resource: 0,
        unattended: 0,
        anonymous: 0,
        role_denied: 150,
        ceiling: 200,
        delegate: 200,
        no_access: 400,
        role_too_low: 410,
        tag_missing: 420,
        provenance: 430,
        needs_subject: 500,
        model_error: 900,
        residual_false: 900,
      });
    });

    it('is frozen', () => {
      expect(Object.isFrozen(DEFAULT_DENY_PRIORITY)).to.eq(true);
    });

    it('ranks role_denied above ceilings and plain no_access', () => {
      expect(denyPriority({ code: 'role_denied' })).to.eq(150);
      expect(compareDenyReasons({ code: 'role_denied', model: 'rbac' }, { code: 'ceiling' })).to.be.lessThan(0);
      expect(compareDenyReasons({ code: 'role_denied', model: 'rbac' }, { code: 'no_access', model: 'rbac' })).to.be.lessThan(0);
      expect(compareDenyReasons({ code: 'unknown_resource' }, { code: 'role_denied', model: 'rbac' })).to.be.lessThan(0);
    });

    it('is exported from the package root', () => {
      expect(root.DEFAULT_DENY_PRIORITY).to.eq(DEFAULT_DENY_PRIORITY);
      expect(root.UNKNOWN_DENY_PRIORITY).to.eq(500);
      expect(root.denyPriority).to.eq(denyPriority);
      expect(root.compareDenyReasons).to.eq(compareDenyReasons);
    });
  });

  describe('denyPriority', () => {
    it('prefers an explicit priority, also 0', () => {
      expect(denyPriority(reason('no_access', { priority: 100 }))).to.eq(100);
      expect(denyPriority(reason('no_access', { priority: 0 }))).to.eq(0);
      expect(denyPriority(reason('no_access', { priority: -5 }))).to.eq(-5);
    });

    it('reads the table by code', () => {
      expect(denyPriority(reason('ceiling'))).to.eq(200);
      expect(denyPriority(reason('residual_false'))).to.eq(900);
    });

    it('gives UNKNOWN_DENY_PRIORITY to unknown codes', () => {
      expect(UNKNOWN_DENY_PRIORITY).to.eq(500);
      expect(denyPriority(reason('agents_disabled'))).to.eq(500);
    });

    it('ignores Object.prototype keys', () => {
      for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        expect(denyPriority(reason(code))).to.eq(UNKNOWN_DENY_PRIORITY);
      }
    });

    it('ignores a non-finite priority', () => {
      expect(denyPriority(reason('no_access', { priority: NaN }))).to.eq(400);
      expect(denyPriority(reason('no_access', { priority: Infinity }))).to.eq(400);
      expect(denyPriority(reason('x', { priority: -Infinity }))).to.eq(UNKNOWN_DENY_PRIORITY);
      expect(denyPriority({ code: 'no_access', priority: '1' as unknown as number })).to.eq(400);
    });
  });

  describe('compareDenyReasons', () => {
    it('orders by priority first', () => {
      expect(compareDenyReasons(reason('unknown_resource'), reason('no_access'))).to.be.lessThan(0);
      expect(compareDenyReasons(reason('model_error'), reason('no_access'))).to.be.greaterThan(0);
      expect(compareDenyReasons(reason('a', { priority: 1, sortKey: 'z' }), reason('b', { priority: 2, sortKey: 'a' }))).to.be.lessThan(0);
    });

    it('breaks priority ties by sortKey in code point order', () => {
      expect(compareDenyReasons(reason('x', { priority: 1, sortKey: 'B' }), reason('x', { priority: 1, sortKey: 'a' }))).to.be.lessThan(0);
      expect(compareDenyReasons(reason('x', { priority: 1, sortKey: 'release/*' }), reason('x', { priority: 1, sortKey: 'release/x' }))).to.be.lessThan(0);
    });

    it('compares by code point, astral after U+FF5E', () => {
      expect(compareDenyReasons(reason('x', { priority: 1, sortKey: '😀' }), reason('x', { priority: 1, sortKey: '～' }))).to.be.greaterThan(0);
      expect(compareDenyReasons(reason('x', { priority: 1, sortKey: '～' }), reason('x', { priority: 1, sortKey: '😀' }))).to.be.lessThan(0);
      expect(compareDenyReasons(reason('x', { priority: 1, sortKey: '𐀀' }), reason('x', { priority: 1, sortKey: '' }))).to.be.greaterThan(0);
    });

    it('picks the same winner in both input orders when only the payload differs', () => {
      const r1 = { code: 'role_too_low', model: 'rbac', ladder: 'project', role: 'viewer', needed: 'editor' };
      const r2 = { code: 'role_too_low', model: 'rbac', ladder: 'org', role: 'viewer', needed: 'editor' };
      expect([r1, r2].sort(compareDenyReasons)[0]).to.eq([r2, r1].sort(compareDenyReasons)[0]);
      expect(compareDenyReasons(r1, r2)).to.eq(-compareDenyReasons(r2, r1));
      expect(compareDenyReasons(r1, r2)).not.to.eq(0);
    });

    it('ignores payload key order and survives unserialisable payloads', () => {
      expect(compareDenyReasons({ code: 'x', a: 1, b: { c: 1, d: 2 } }, { code: 'x', b: { d: 2, c: 1 }, a: 1 })).to.eq(0);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => compareDenyReasons({ code: 'x', v: cyclic }, { code: 'x', v: 1n })).not.to.throw();
    });

    it('does not break on non-string code or sortKey', () => {
      const list = [
        { code: 'x', sortKey: 3 },
        { code: 'x', sortKey: 'a' },
        { code: 'x', sortKey: '10' },
      ] as unknown as DenyReason[];
      const a = [...list].sort(compareDenyReasons).map((r) => String(r.sortKey));
      const b = [...list]
        .reverse()
        .sort(compareDenyReasons)
        .map((r) => String(r.sortKey));
      expect(a).to.deep.eq(b);
    });

    it('puts an absent sortKey first', () => {
      expect(compareDenyReasons(reason('x', { priority: 1 }), reason('x', { priority: 1, sortKey: 'a' }))).to.be.lessThan(0);
      expect(compareDenyReasons(reason('x', { priority: 1, sortKey: '' }), reason('x', { priority: 1 }))).to.eq(0);
    });

    it('then compares code, then model', () => {
      expect(compareDenyReasons(reason('a', { priority: 1 }), reason('b', { priority: 1 }))).to.be.lessThan(0);
      expect(compareDenyReasons(reason('a', { priority: 1, model: 'rbac' }), reason('a', { priority: 1, model: 'abac' }))).to.be.greaterThan(0);
      expect(compareDenyReasons(reason('a', { priority: 1 }), reason('a', { priority: 1, model: 'abac' }))).to.be.lessThan(0);
      expect(compareDenyReasons(reason('a', { model: 'm' }), reason('a', { model: 'm' }))).to.eq(0);
    });

    it('sorts any permutation to the same order', () => {
      const arb = fc.record(
        {
          code: fc.constantFrom('no_access', 'ceiling', 'model_error', 'x', 'constructor', 'b'),
          model: fc.constantFrom('rbac', 'abac'),
          priority: fc.constantFrom(0, 100, 400, NaN),
          sortKey: fc.constantFrom('', 'B', 'a', 'release/*', 'release/x'),
        },
        { requiredKeys: ['code'] },
      );
      const key = (r: DenyReason) => JSON.stringify([r.code, denyPriority(r), r.sortKey ?? '', r.model ?? '']);
      fc.assert(
        fc.property(fc.array(arb, { maxLength: 12 }), fc.infiniteStream(fc.nat()), (list, rnd) => {
          const base = [...list].sort(compareDenyReasons).map(key);
          const it = rnd[Symbol.iterator]();
          const shuffled = [...list];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = it.next().value % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          expect(shuffled.sort(compareDenyReasons).map(key)).to.deep.eq(base);
        }),
      );
    });
  });

  describe('errors', () => {
    const denied: Decision = { ...decision, allowed: false, reason: { code: 'no_access' } };

    it('AccessDenied is a Forbidden carrying the decision', () => {
      const e = new AccessDenied(denied);
      expect(e).to.be.instanceOf(Forbidden);
      expect(e).to.be.instanceOf(Exception);
      expect(e).to.be.instanceOf(Error);
      expect(e.decision).to.eq(denied);
      expect(e.name).to.eq('AccessDenied');
      expect(e.message).to.contain('doc.read');
      expect(e.message).to.contain('doc:1');
      expect(e.message).to.contain('no_access');
    });

    it('keeps the decision out of enumerable and serialised state', () => {
      const e = new AccessDenied(denied);
      expect(Object.keys(e)).not.to.include('decision');
      expect({ ...e }).not.to.have.property('decision');
      expect(JSON.stringify(e)).not.to.contain('decision');
      expect(e.decision).to.eq(denied);
    });

    it('AccessDenied takes an optional message', () => {
      expect(new AccessDenied(denied, 'nope').message).to.eq('nope');
    });

    it('AccessDenied copes with a decision without reason', () => {
      const e = new AccessDenied({ ...denied, reason: undefined });
      expect(e.message).to.contain('doc.read');
    });

    it('Unauthenticated is an AuthenticationFailed', () => {
      const e = new Unauthenticated('who?');
      expect(e).to.be.instanceOf(AuthenticationFailed);
      expect(e).to.be.instanceOf(Error);
      expect(e.name).to.eq('Unauthenticated');
      expect(e.message).to.eq('who?');
    });

    it('NeedsAsync is an Error', () => {
      const e = new NeedsAsync('later');
      expect(e).to.be.instanceOf(Error);
      expect(e.name).to.eq('NeedsAsync');
    });

    it('exports them from the package root', () => {
      expect(root.AccessDenied).to.eq(AccessDenied);
      expect(root.Unauthenticated).to.eq(Unauthenticated);
      expect(root.NeedsAsync).to.eq(NeedsAsync);
    });
  });
});

describe('compareDenyReasons payload tie-break', () => {
  it('keeps a __proto__ payload key from parsed JSON and never throws on a throwing getter', () => {
    const a = JSON.parse('{"code":"x","__proto__":{"n":1}}') as DenyReason;
    const b = JSON.parse('{"code":"x","__proto__":{"n":2}}') as DenyReason;
    expect(compareDenyReasons(a, b)).to.not.eq(0);
    expect(Math.sign(compareDenyReasons(a, b))).to.eq(-Math.sign(compareDenyReasons(b, a)));

    const g = { code: 'x' } as DenyReason;
    Object.defineProperty(g, 'boom', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(() => compareDenyReasons(g, { code: 'x', y: 1 })).to.not.throw();
  });
});
