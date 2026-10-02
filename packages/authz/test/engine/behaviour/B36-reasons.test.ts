import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { FirstApplicable } from '../../../src/engine/combinators.js';
import { selectDenyReason, staticTruths } from '../../../src/engine/reasons.js';
import { Authorizer } from '../../../src/engine/authorizer.js';
import { FALSE, TRUE, and, or } from '../../../src/index.js';
import type { DenyReason, ResourceFilter, Vote } from '../../../src/index.js';
import { FakeAdapter, FakeRelation, FakeRow, RecordingLog, StaticModel, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const vote = (model: string, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...extra });
const denying = (model: string, ...reasons: DenyReason[]): Vote => vote(model, { denyWhen: TRUE, denies: reasons.map((reason) => ({ when: TRUE, reason })) });

// Core part of B36, as the engine wires it: static truths, every routed model counted under deny-overrides.
const reasonOf = (votes: readonly Vote[], core: readonly DenyReason[] = [], algorithm = 'deny-overrides', deciding?: Vote): DenyReason => selectDenyReason({ core, votes, truths: votes.map(staticTruths), algorithm, deciding, subjectEvaluated: false });

const permutations = <T>(xs: readonly T[]): T[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

describe('B36: deny reasons do not depend on model or rule order', () => {
  it('B36: under deny-overrides every routed model counts and the lowest (priority, sortKey) wins in any model order', () => {
    const rbac = vote('rbac', { reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' } });
    const abac = denying('abac', { code: 'outside_hours', priority: 300 }, { code: 'agents_disabled', priority: 100 });
    const fs = denying('fs', { code: 'branch_locked', priority: 100, sortKey: 'main' });
    for (const order of permutations([rbac, abac, fs])) {
      expect(reasonOf(order)).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    }
  });

  it('B36: canvas C6 — agents_disabled (100) is reported before a ceiling out_of_scope (200)', () => {
    const abac = denying('abac', { code: 'agents_disabled', priority: 100 });
    const core: DenyReason[] = [{ code: 'out_of_scope', priority: 200 }];
    expect(reasonOf([abac], core)).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    expect(reasonOf([vote('rbac', { reason: { code: 'role_too_low' } })], core)).to.deep.equal({ code: 'out_of_scope', priority: 200 });
  });

  it('B36: a model_error ranks last, so a real reason from another model is reported', () => {
    const bad: Vote = { model: 'bad', permitWhen: FALSE, denyWhen: TRUE, error: 'timeout', cacheable: false };
    const rbac = vote('rbac', { reason: { code: 'role_too_low' } });
    for (const order of permutations([bad, rbac])) expect(reasonOf(order)).to.deep.equal({ code: 'role_too_low', model: 'rbac' });
  });

  it('B36: an indeterminate deciding vote (a normalized copy, not one of the votes) gives model_error', () => {
    const bad: Vote = { model: 'bad', permitWhen: TRUE, denyWhen: FALSE, error: 'boom', cacheable: false };
    const votes = [vote('rbac', { reason: { code: 'role_too_low' } }), bad];
    const combined = new FirstApplicable().combine(votes);
    expect(combined.deciding).not.to.equal(undefined);
    expect(reasonOf(votes, [], 'first-applicable', combined.deciding)).to.deep.equal({ code: 'model_error', model: 'bad' });
  });

  it('B36: under first-applicable the deciding vote alone gives the reason, whatever was evaluated after it', () => {
    const deciding = denying('acl', { code: 'blocked', priority: 600 });
    // Inapplicable, so not deciding; its reason would win if it counted.
    const before = vote('rbac', { reason: { code: 'role_too_low' } });
    const after = denying('abac', { code: 'agents_disabled', priority: 100 });
    const votes = [before, deciding, after];
    const combined = new FirstApplicable().combine(votes);
    expect(combined.deciding).to.equal(deciding);
    expect(reasonOf(votes, [], 'first-applicable', combined.deciding)).to.deep.equal({ code: 'blocked', priority: 600, model: 'acl' });
    expect(reasonOf([before, deciding], [], 'first-applicable', combined.deciding)).to.deep.equal({ code: 'blocked', priority: 600, model: 'acl' });
  });

  it('B36: random models, rules and orders give one reason (fast-check)', () => {
    const reasonArb = fc.record({ code: fc.constantFrom('a', 'b', 'role_too_low', 'ceiling'), priority: fc.integer({ min: 0, max: 5 }).map((n) => n * 100), sortKey: fc.constantFrom('x', 'y') }, { requiredKeys: ['code'] }) as fc.Arbitrary<DenyReason>;
    const voteArb = fc.record({ model: fc.constantFrom('m1', 'm2', 'm3'), denies: fc.array(reasonArb, { maxLength: 3 }), reason: fc.option(reasonArb, { nil: undefined }) });
    fc.assert(
      fc.property(fc.array(voteArb, { minLength: 1, maxLength: 4 }), fc.array(reasonArb, { maxLength: 2 }), (gen, core) => {
        const votes = gen.map((g) => (g.reason ? { ...denying(g.model, ...g.denies), reason: g.reason } : denying(g.model, ...g.denies)));
        const expected = reasonOf(votes, core);
        const reversed = reasonOf(
          [...votes].reverse().map((v) => ({ ...v, denies: v.denies && [...v.denies].reverse() })),
          [...core].reverse(),
        );
        expect(reversed).to.deep.equal(expected);
      }),
      { numRuns: 300 },
    );
  });
});

describe('B36: deny reasons through the Authorizer', () => {
  const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
  const alice = principal('user', 'alice');
  const owner: ResourceFilter = { op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } };
  const locked: ResourceFilter = { op: 'cmp', field: 'locked', cmp: 'eq', value: true };
  const blocked: ResourceFilter = { op: 'relation', relation: 'blocked' };

  it('B36: the reason does not depend on model order', async () => {
    const specs: [string, Partial<Vote>][] = [
      ['rbac', { reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' } }],
      [
        'abac',
        {
          denyWhen: TRUE,
          denies: [
            { when: TRUE, reason: { code: 'outside_hours', priority: 300 } },
            { when: TRUE, reason: { code: 'agents_disabled', priority: 100 } },
          ],
        },
      ],
      ['fs', { denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'branch_locked', priority: 100, sortKey: 'main' } }] }],
    ];
    for (const order of permutations([0, 1, 2])) {
      const models = order.map((i) => new StaticModel(specs[i][0], { vote: specs[i][1] }));
      const d = await new Authorizer({ domain: 'root', registry, models }).check({ principal: alice, permission: 'doc:read' });
      expect(d.reason, `${order}`).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    }
  });

  it('B36: canvas order — unknown_resource (0) before agents_disabled (100) before a ceiling out_of_scope (200)', async () => {
    const bob = principal('user', 'bob');
    const agent = principal('agent', 'bot', { onBehalfOf: bob, delegation: 'inherit', ceiling: { resources: [{ type: 'doc', id: 'd1' }], reason: 'out_of_scope' } });
    const rows = [new FakeRow('doc', 'd1'), new FakeRow('doc', 'd2')];
    const make = (agentsEnabled: boolean) => {
      const rbac = new StaticModel('rbac', { vote: (req) => ({ model: 'rbac', permitWhen: req.principal.id === 'bob' ? TRUE : FALSE, denyWhen: FALSE, cacheable: true }) });
      const abac = new StaticModel('abac', {
        vote: (req) => {
          const off = !agentsEnabled && req.actor?.type === 'agent';
          return { model: 'abac', permitWhen: FALSE, denyWhen: off ? TRUE : FALSE, denies: off ? [{ when: TRUE, reason: { code: 'agents_disabled', priority: 100 } }] : [], cacheable: true };
        },
      });
      return { rbac, a: new Authorizer({ domain: 'root', registry, models: [abac, rbac], adapters: [new FakeAdapter(['doc'], { rows })] }) };
    };
    const off = make(false);
    const unknown = await off.a.check({ principal: agent, permission: 'doc:read', resource: { type: 'doc', id: 'd9' } });
    expect(unknown.reason).to.deep.equal({ code: 'unknown_resource' });
    expect(off.rbac.calls).to.have.length(0);
    expect((await off.a.check({ principal: agent, permission: 'doc:read', resource: { type: 'doc', id: 'd2' } })).reason).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    const on = make(true);
    expect((await on.a.check({ principal: agent, permission: 'doc:read', resource: { type: 'doc', id: 'd2' } })).reason).to.deep.equal({ code: 'out_of_scope', priority: 200 });
    expect((await on.a.check({ principal: agent, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } })).allowed).to.equal(true);
  });

  it('B36: a model reason replaces no_access', async () => {
    const d = await new Authorizer({ domain: 'root', registry, models: [new StaticModel('rbac', { vote: { reason: { code: 'role_too_low' } } })] }).check({ principal: alice, permission: 'doc:read' });
    expect(d.reason).to.deep.equal({ code: 'role_too_low', model: 'rbac' });
  });

  describe('with a subject, the counted votes are evaluated against it', () => {
    const setup = (rows: FakeRow[], relation?: FakeRelation, timeoutMs = 2000) => {
      const log = new RecordingLog();
      const a = new Authorizer({
        domain: 'root',
        registry,
        log,
        adapters: [new FakeAdapter(['doc'], { rows })],
        relations: relation ? [relation] : [],
        config: { modelTimeoutMs: timeoutMs },
        models: [
          new StaticModel('rbac', { vote: { permitWhen: owner, reason: { code: 'not_owner', priority: 450 } } }),
          new StaticModel('acl', {
            vote: {
              denyWhen: or(locked, blocked),
              denies: [
                { when: locked, reason: { code: 'locked', priority: 300 } },
                { when: blocked, reason: { code: 'blocked', priority: 100 } },
              ],
            },
          }),
        ],
      });
      return { a, log };
    };

    it('B36: a deny entry true for the row wins; a permit false for the row reports the model reason', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'bob', locked: true }), new FakeRow('doc', 'd2', { owner: 'bob', locked: false }), new FakeRow('doc', 'd3', { owner: 'alice', locked: true })];
      const { a } = setup(rows, new FakeRelation('doc', 'blocked', () => false));
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[0] })).reason).to.deep.equal({ code: 'locked', priority: 300, model: 'acl' });
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[1] })).reason).to.deep.equal({ code: 'not_owner', priority: 450, model: 'rbac' });
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[2] })).reason).to.deep.equal({ code: 'locked', priority: 300, model: 'acl' });
      const typeLevel = await a.check({ principal: alice, permission: 'doc:read' });
      expect(typeLevel.allowed).to.equal(true);
      expect(typeLevel).to.not.have.property('reason');
    });

    it('B36: a relation that holds for the row reports its deny entry', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'bob', locked: false })];
      const { a } = setup(rows, new FakeRelation('doc', 'blocked', () => true));
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[0] })).reason).to.deep.equal({ code: 'blocked', priority: 100, model: 'acl' });
    });

    it('B36: a relation that never settles in the reason pass falls back to the static truths and is logged', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'bob', locked: false })];
      const hanging = new FakeRelation('doc', 'blocked', () => new Promise<boolean>(() => undefined));
      const { a, log } = setup(rows, hanging, 30);
      const t0 = Date.now();
      const d = await a.check({ principal: alice, permission: 'doc:read', resource: rows[0] });
      expect(Date.now() - t0).to.be.below(5000);
      // Once, by the reason pass: the subject check itself must have denied on the owner without reaching it.
      expect(hanging.calls).to.have.length(1);
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'not_owner', priority: 450, model: 'rbac' });
      expect(log.at('error').some((e) => /reason/.test(e.message))).to.equal(true);
    });

    it('B36: one time limit covers the whole reason pass: two deny entries each under it, together over it, fall back once', async () => {
      const limitMs = 500;
      const workMs = 300;
      const rows = [new FakeRow('doc', 'd1', { owner: 'bob' })];
      // One connection: each call waits for the previous one, then works workMs.
      let queue: Promise<unknown> = Promise.resolve();
      const durations: number[] = [];
      const serial = () => {
        const run = queue.then(async () => {
          const t = Date.now();
          await new Promise((r) => setTimeout(r, workMs));
          durations.push(Date.now() - t);
          return true;
        });
        queue = run;
        return run;
      };
      const r1 = new FakeRelation('doc', 'r1', serial);
      const r2 = new FakeRelation('doc', 'r2', serial);
      const log = new RecordingLog();
      const a = new Authorizer({
        domain: 'root',
        registry,
        log,
        adapters: [new FakeAdapter(['doc'], { rows })],
        relations: [r1, r2],
        config: { modelTimeoutMs: limitMs },
        models: [
          new StaticModel('rbac', { vote: { reason: { code: 'not_owner', priority: 450 } } }),
          new StaticModel('acl', {
            vote: {
              denyWhen: or({ op: 'relation', relation: 'r1' }, { op: 'relation', relation: 'r2' }),
              denies: [
                { when: { op: 'relation', relation: 'r1' }, reason: { code: 'one', priority: 100 } },
                { when: { op: 'relation', relation: 'r2' }, reason: { code: 'two', priority: 100 } },
              ],
            },
          }),
        ],
      });
      const d = await a.explain({ principal: alice, permission: 'doc:read', resource: rows[0] });
      await queue;
      expect(r1.calls.length + r2.calls.length).to.equal(2);
      for (const ms of durations) expect(ms).to.be.below(limitMs);
      expect(d.reason).to.deep.equal({ code: 'not_owner', priority: 450, model: 'rbac' });
      expect(log.at('error').filter((e) => /deny reasons/.test(e.message))).to.have.length(1);
      expect(d.trace!.steps.filter((s) => s.by === 'core' && s.step === 'reason').map((s) => s.data)).to.deep.equal([{ fallback: 'static' }]);
    });

    it('B36: residual_false only when no vote gives a reason; explain records one core reason step', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'bob' })];
      const a = new Authorizer({ domain: 'root', registry, adapters: [new FakeAdapter(['doc'], { rows })], models: [new StaticModel('m', { vote: { permitWhen: owner } })] });
      const d = await a.explain({ principal: alice, permission: 'doc:read', resource: rows[0] });
      expect(d.reason).to.deep.equal({ code: 'residual_false' });
      const core = d.trace!.steps.filter((s) => s.by === 'core');
      expect(core.filter((s) => s.step === 'subject')).to.have.length(1);
      const reasonSteps = core.filter((s) => s.step === 'reason');
      expect(reasonSteps).to.have.length(1);
      expect(reasonSteps[0].data).to.deep.equal({ truths: [{ model: 'm', permit: false, denies: [] }] });
    });

    it('B36: a deny entry is judged in deny polarity, so a missing ref holds it as it does in the allow', async () => {
      const deptMissing: ResourceFilter = { op: 'cmp', field: 'dept', cmp: 'eq', value: { ref: 'principal.attributes.nope' } };
      const when = and(locked, deptMissing);
      const rows = [new FakeRow('doc', 'd1', { owner: 'alice', locked: true, dept: 'x' }), new FakeRow('doc', 'd2', { owner: 'alice', locked: false, dept: 'x' })];
      const a = new Authorizer({
        domain: 'root',
        registry,
        adapters: [new FakeAdapter(['doc'], { rows })],
        models: [new StaticModel('m', { vote: { permitWhen: owner, denyWhen: when, denies: [{ when, reason: { code: 'dept_locked', priority: 100 } }] } })],
      });
      const d = await a.explain({ principal: alice, permission: 'doc:read', resource: rows[0] });
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'dept_locked', priority: 100, model: 'm' });
      expect(d.trace!.steps.find((s) => s.by === 'core' && s.step === 'reason')?.data).to.deep.equal({ truths: [{ model: 'm', permit: true, denies: [true] }] });
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[1] })).allowed).to.equal(true);
    });

    it('B36: an allow already FALSE before the subject step still evaluates row-level deny entries', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'alice', locked: true })];
      const b = () => new StaticModel('b', { vote: { permitWhen: owner, denyWhen: locked, denies: [{ when: locked, reason: { code: 'locked', priority: 100 } }] } });
      const staticDeny = new StaticModel('a', { vote: { denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'static_deny', priority: 300 } }] } });
      const a = new Authorizer({ domain: 'root', registry, adapters: [new FakeAdapter(['doc'], { rows })], models: [staticDeny, b()] });
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[0] })).reason).to.deep.equal({ code: 'locked', priority: 100, model: 'b' });

      // A ceiling denial forces FALSE; a row-level model reason below 200 must still beat it (design §7, canvas C6).
      const scoped = principal('user', 'alice', { ceiling: { permissions: [], reason: 'out_of_scope' } });
      const c = new Authorizer({ domain: 'root', registry, adapters: [new FakeAdapter(['doc'], { rows })], models: [b()] });
      expect((await c.check({ principal: scoped, permission: 'doc:read', resource: rows[0] })).reason).to.deep.equal({ code: 'locked', priority: 100, model: 'b' });
    });

    it('B36: against the subject a permit that is not TRUE counts the vote reason, also when the allow was already FALSE', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'alice' })];
      const member = new FakeRelation('doc', 'member', () => Promise.reject(new Error('down')));
      const scoped = principal('user', 'alice', { ceiling: { permissions: [], reason: 'out_of_scope' } });
      const a = new Authorizer({
        domain: 'root',
        registry,
        adapters: [new FakeAdapter(['doc'], { rows })],
        relations: [member],
        models: [new StaticModel('team', { vote: { permitWhen: { op: 'relation', relation: 'member' }, reason: { code: 'not_member', priority: 100 } } })],
      });
      expect((await a.check({ principal: scoped, permission: 'doc:read', resource: rows[0] })).reason).to.deep.equal({ code: 'not_member', priority: 100, model: 'team' });
      expect(member.calls).to.have.length(1);
    });

    it('B36: an allow already FALSE before the subject step and no candidate gives no_access, not residual_false', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'alice' })];
      const a = new Authorizer({ domain: 'root', registry, adapters: [new FakeAdapter(['doc'], { rows })], models: [new StaticModel('m', { vote: { denyWhen: locked } })] });
      const d = await a.explain({ principal: alice, permission: 'doc:read', resource: rows[0] });
      expect(d.reason).to.deep.equal({ code: 'no_access' });
      const core = d.trace!.steps.filter((s) => s.by === 'core');
      expect(core.filter((s) => s.step === 'subject')).to.have.length(0);
      expect(core.filter((s) => s.step === 'reason').map((s) => s.data)).to.deep.equal([{ truths: [{ model: 'm', permit: false, denies: [] }] }]);
    });

    it('B36: under first-applicable only the deciding vote is evaluated against the subject and traced', async () => {
      const rows = [new FakeRow('doc', 'd1', { owner: 'bob', locked: true })];
      const r2 = new FakeRelation('doc', 'r2', () => true);
      const a = new Authorizer({
        domain: 'root',
        registry,
        combine: { default: { algorithm: 'first-applicable' } },
        adapters: [new FakeAdapter(['doc'], { rows })],
        relations: [r2],
        models: [new StaticModel('m1', { vote: { permitWhen: TRUE, denyWhen: locked, denies: [{ when: locked, reason: { code: 'locked', priority: 300 } }] } }), new StaticModel('m2', { vote: { denyWhen: { op: 'relation', relation: 'r2' }, denies: [{ when: { op: 'relation', relation: 'r2' }, reason: { code: 'r2', priority: 1 } }] } })],
      });
      const d = await a.explain({ principal: alice, permission: 'doc:read', resource: rows[0] });
      expect(d.reason).to.deep.equal({ code: 'locked', priority: 300, model: 'm1' });
      expect(r2.calls).to.have.length(0);
      expect(d.trace!.steps.find((s) => s.by === 'core' && s.step === 'reason')?.data).to.deep.equal({ truths: [{ model: 'm1', permit: true, denies: [true] }] });
      expect((await a.check({ principal: alice, permission: 'doc:read', resource: rows[0] })).reason).to.deep.equal({ code: 'locked', priority: 300, model: 'm1' });
    });
  });
});
