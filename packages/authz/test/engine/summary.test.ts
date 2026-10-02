import * as chai from 'chai';
import 'mocha';

import { Authorizer, MAX_SUMMARY_PERMISSIONS } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { AuthzConfigError, CORE_FILTER_OPS, FALSE, GLOBAL, PermissionRegistry, SYSTEM, TRUE, UNATTENDED } from '../../src/index.js';
import type { DecisionRequest, EvaluationContext, ModelSummary, Permission, PermissionDef, Principal, ResourceFilter, ResourceRef, Vote } from '../../src/index.js';
import type { PermissionInput } from '../../src/engine/registry.js';
import { DenyOverrides } from '../../src/engine/combinators.js';
import { FakeScopeResolver, RecordingAudit, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';
import type { StaticModelOptions } from './fakes.js';

const expect = chai.expect;

const DEFS: readonly PermissionInput[] = [
  { name: 'doc:write', types: ['doc'], fields: true },
  { name: 'doc:read', types: ['doc'], fields: true },
  { name: 'doc:delete', types: ['doc'] },
  { name: 'org:view', types: ['org'] },
];
const REG = registryOf(DEFS);

const alice = principal('user', 'alice');
const bob = principal('user', 'bob');
const owner: ResourceFilter = { op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } };
const isPublic: ResourceFilter = { op: 'cmp', field: 'status', cmp: 'eq', value: 'public' };
const member: ResourceFilter = { op: 'relation', relation: 'member' };
const acl: ResourceFilter = { op: 'native:acl', args: { level: 1 } };

type Grants = Readonly<Record<string, Readonly<Record<string, Partial<Vote>>>>>;

/** An RBAC-like model: principal id => permission => the vote's fields. */
const table =
  (name: string, grants: Grants) =>
  (req: DecisionRequest): Vote =>
    ({ model: name, permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...(grants[req.principal.id]?.[req.permission] ?? {}) } as Vote);

const P = (when: ResourceFilter = TRUE, extra: Partial<Vote> = {}): Partial<Vote> => ({ permitWhen: when, ...extra });

class SummaryModel extends StaticModel {
  readonly summaries: { readonly principal: Principal; readonly at: ResourceRef; readonly ctx: EvaluationContext }[] = [];

  constructor(name: string, options: StaticModelOptions, private readonly impl: (p: Principal, at: ResourceRef) => unknown) {
    super(name, options);
  }

  summarize(p: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    this.summaries.push({ principal: p, at, ctx });
    return Promise.resolve().then(() => this.impl(p, at)) as Promise<ModelSummary>;
  }
}

/** Delegates to REG, but require() throws for one name: a check of it throws. */
class ThrowingRegistry extends PermissionRegistry {
  constructor(private readonly bad: Permission) {
    super();
  }
  get(name: Permission): PermissionDef | undefined {
    return REG.get(name);
  }
  require(name: Permission): PermissionDef {
    if (name === this.bad) throw new Error('registry down');
    return REG.require(name);
  }
  match(glob: string): readonly PermissionDef[] {
    return REG.match(glob);
  }
  impliedBy(name: Permission): readonly Permission[] {
    return REG.impliedBy(name);
  }
  all(): readonly PermissionDef[] {
    return REG.all();
  }
}

let log: RecordingLog;
let audit: RecordingAudit;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  log = new RecordingLog();
  audit = new RecordingAudit();
  clock = fakeClock();
});

const make = (options: Partial<AuthorizerOptions> = {}): Authorizer => new Authorizer({ domain: 'root', models: [], registry: REG, clock: clock.clock, log, audit, ...options });

function deepFrozen(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v !== 'object' || seen.has(v)) return true;
  seen.add(v);
  if (!Object.isFrozen(v)) return false;
  return Object.values(v as object).every((x) => deepFrozen(x, seen));
}

const names = (s: { readonly permissions: readonly { readonly name: string }[] }): string[] => s.permissions.map((p) => p.name);

describe('Authorizer.summary', () => {
  it('lists allowed permissions sorted by name: TRUE is unconditional, a residual conditional, denied ones are left out', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:write': P(), 'doc:read': P(owner), 'doc:delete': P(isPublic) } }) });
    const a = make({ models: [rbac] });
    const s = await a.summary(alice);
    expect(s.principal).to.deep.equal({ type: 'user', id: 'alice' });
    expect(s.models).to.deep.equal([]);
    expect(s).to.not.have.property('ceiling');
    expect(names(s)).to.deep.equal(['doc:delete', 'doc:read', 'doc:write']);
    expect(s.permissions.map((p) => p.conditional)).to.deep.equal([true, true, false]);
    expect(deepFrozen(s)).to.equal(true);
  });

  it('carries the decision fields only for permissions whose def has fields', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:write': P(TRUE, { fields: { write: ['title'] } }), 'doc:read': P(TRUE, { fields: { read: ['title', 'body'] } }), 'doc:delete': P() } }) });
    const a = make({ models: [rbac] });
    const s = await a.summary(alice);
    const byName = Object.fromEntries(s.permissions.map((p) => [p.name, p]));
    expect(byName['doc:delete']).to.not.have.property('fields');
    const read = await a.check({ principal: alice, permission: 'doc:read', resource: GLOBAL });
    const write = await a.check({ principal: alice, permission: 'doc:write', resource: GLOBAL });
    expect(byName['doc:read'].fields).to.deep.equal({ read: read.fields.read, write: read.fields.write });
    expect(byName['doc:write'].fields).to.deep.equal({ read: write.fields.read, write: ['title'] });
  });

  it('at defaults to GLOBAL; the checks run on the $global ref', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'org:view': P() } }) });
    const a = make({ models: [rbac] });
    await a.summary(alice);
    expect(rbac.calls.length).to.be.greaterThan(0);
    expect(rbac.calls.every((c) => c.req.resource.type === '$global' && c.req.resource.id === undefined)).to.equal(true);
  });

  it('candidates are the registered names the model summaries list; a listed name the check denies is left out', async () => {
    const vote = table('rbac', { alice: { 'doc:read': P(), 'doc:write': P(), 'org:view': P() } });
    const rbac = new SummaryModel('rbac', { vote }, () => ({
      model: 'forged',
      roles: [{ role: 'editor', scope: GLOBAL, expiresAt: '2027-01-01T00:00:00.000Z' }],
      permissions: [
        { name: 'doc:read', conditional: false },
        { name: 'doc:delete', conditional: false },
        { name: 'nope:x', conditional: false },
        { name: 'not a name', conditional: true },
      ],
    }));
    const a = make({ models: [rbac] });
    const s = await a.summary(alice);
    // doc:write and org:view are allowed but no summary names them; doc:delete is named but denied.
    expect(names(s)).to.deep.equal(['doc:read']);
    expect(rbac.calls.map((c) => c.req.permission).sort()).to.deep.equal(['doc:delete', 'doc:read']);
    expect(s.models).to.have.length(1);
    expect(s.models[0].model).to.equal('rbac');
    expect(s.models[0].roles).to.deep.equal([{ role: 'editor', scope: { type: '$global' }, expiresAt: '2027-01-01T00:00:00.000Z' }]);
    expect(s.models[0].permissions).to.have.length(4);
    expect(rbac.summaries).to.have.length(1);
    expect(rbac.summaries[0].principal).to.equal(alice);
    expect(rbac.summaries[0].at).to.deep.equal(GLOBAL);
    expect(deepFrozen(s)).to.equal(true);
  });

  it('a model summary is an engine copy: changing the model object later does not change it', async () => {
    const raw = { model: 'rbac', permissions: [{ name: 'doc:read', conditional: false }] };
    const rbac = new SummaryModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P() } }) }, () => raw);
    const s = await make({ models: [rbac] }).summary(alice);
    raw.permissions.push({ name: 'doc:write', conditional: false });
    expect(s.models[0].permissions).to.have.length(1);
    expect(Object.isFrozen(raw)).to.equal(false);
  });

  it('a routed model without summarize makes every registered permission a candidate', async () => {
    const rbac = new SummaryModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P() } }) }, () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false }] }));
    const abac = new StaticModel('abac', { vote: table('abac', { alice: { 'org:view': P() } }), capabilities: { effects: ['permit', 'deny'] } });
    const a = make({ models: [rbac, abac], combine: { default: { algorithm: 'permit-overrides' } } });
    const s = await a.summary(alice);
    expect(names(s)).to.deep.equal(['doc:read', 'org:view']);
    expect(s.models.map((m) => m.model)).to.deep.equal(['rbac']);
  });

  it('a model that is not routed at the summary type does not widen the candidates', async () => {
    const rbac = new SummaryModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P() } }) }, () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false }] }));
    const orgOnly = new StaticModel('org-only', { applies: (def) => def.name === 'org:view', vote: table('org-only', { alice: { 'org:view': P() } }) });
    const resolver = new FakeScopeResolver(['doc'], { 'doc:d1': null });
    const a = make({ models: [rbac, orgOnly], scopeResolvers: [resolver] });
    const s = await a.summary(alice, { type: 'doc', id: 'd1' });
    expect(names(s)).to.deep.equal(['doc:read']);
    expect(orgOnly.calls).to.have.length(0);
  });

  it('a summarize that throws, rejects, times out or returns garbage is left out and logged; the candidates fall back to every registered permission', async () => {
    const vote = table('rbac', { alice: { 'doc:read': P(), 'org:view': P() } });
    const cases: (() => unknown)[] = [
      () => {
        throw new Error('boom');
      },
      () => Promise.reject(new Error('down')),
      () => new Promise(() => {}),
      () => ({ model: 'rbac', permissions: 'all' }),
      () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: 'no' }] }),
      () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false, fields: { read: [1] } }] }),
      () => ({ model: 'rbac', roles: [{ role: 'r', scope: { id: 'x' } }], permissions: [] }),
      () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false, fn: () => 1 }] }),
    ];
    for (const impl of cases) {
      log = new RecordingLog();
      const rbac = new SummaryModel('rbac', { vote }, impl);
      const a = make({ models: [rbac], config: { modelTimeoutMs: 30 } });
      const s = await a.summary(alice);
      expect(s.models).to.deep.equal([]);
      expect(names(s)).to.deep.equal(['doc:read', 'org:view']);
      expect(log.at('error').some((e) => e.message.includes('rbac') && e.message.includes('summar'))).to.equal(true);
    }
  });

  it('SYSTEM: every registered permission, unconditional, without calling a model', async () => {
    const rbac = new SummaryModel('rbac', { vote: P(FALSE) }, () => ({ model: 'rbac', permissions: [] }));
    const a = make({ models: [rbac] });
    const s = await a.summary(SYSTEM);
    expect(s.principal).to.deep.equal({ type: 'system', id: 'system' });
    expect(names(s)).to.deep.equal(['doc:delete', 'doc:read', 'doc:write', 'org:view']);
    expect(s.permissions.every((p) => p.conditional === false)).to.equal(true);
    const read = await a.check({ principal: SYSTEM, permission: 'doc:read' });
    expect(s.permissions.find((p) => p.name === 'doc:read')!.fields).to.deep.equal({ read: read.fields.read, write: read.fields.write });
    expect(s.permissions.find((p) => p.name === 'doc:delete')).to.not.have.property('fields');
    expect(s.models).to.deep.equal([]);
    expect(rbac.calls).to.have.length(0);
    expect(rbac.summaries).to.have.length(0);
    expect(deepFrozen(s)).to.equal(true);
  });

  it('UNATTENDED, a missing principal and forged system/unattended copies: no permissions, no model calls', async () => {
    const rbac = new SummaryModel('rbac', { vote: P() }, () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false }] }));
    const a = make({ models: [rbac] });
    for (const p of [UNATTENDED, undefined, { ...SYSTEM }, principal('system', 'system'), principal('unattended', 'x')]) {
      const s = await a.summary(p as Principal);
      expect(s.permissions).to.deep.equal([]);
      expect(s.models).to.deep.equal([]);
      expect(deepFrozen(s)).to.equal(true);
    }
    expect(rbac.calls).to.have.length(0);
    expect(rbac.summaries).to.have.length(0);
  });

  it('an ABAC-style deny policy removes a permission; a conditional deny makes it conditional', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P(), 'doc:write': P(), 'doc:delete': P() } }) });
    const abac = new StaticModel('abac', {
      vote: (req: DecisionRequest) => ({ model: 'abac', permitWhen: FALSE, denyWhen: req.permission === 'doc:delete' ? TRUE : req.permission === 'doc:write' ? isPublic : FALSE, cacheable: true }),
    });
    const s = await make({ models: [rbac, abac] }).summary(alice);
    expect(s.permissions.map((p) => [p.name, p.conditional])).to.deep.equal([
      ['doc:read', false],
      ['doc:write', true],
    ]);
  });

  it('a ceiling narrows the summary, and the summary carries a frozen copy of it (null fields dropped)', async () => {
    const ceiling = { permissions: ['doc:*'], roles: null, reason: 'out_of_scope' };
    const p = principal('user', 'alice', { ceiling: ceiling as never });
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P(), 'org:view': P() } }) });
    const s = await make({ models: [rbac] }).summary(p);
    expect(names(s)).to.deep.equal(['doc:read']);
    expect(s.ceiling).to.deep.equal({ permissions: ['doc:*'], reason: 'out_of_scope' });
    expect(s.ceiling).to.not.equal(ceiling);
    expect(deepFrozen(s)).to.equal(true);
    expect(Object.isFrozen(ceiling)).to.equal(false);
  });

  it('a typed at checks only the permissions checkable on its type, sharing one scope across the checks', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P(), 'doc:write': P(), 'org:view': P() } }) });
    const resolver = new FakeScopeResolver(['doc'], { 'doc:d1': null });
    const cache = new Map<string, unknown>();
    const s = await make({ models: [rbac], scopeResolvers: [resolver] }).summary(alice, { type: 'doc', id: 'd1' }, { cache });
    expect(names(s)).to.deep.equal(['doc:read', 'doc:write']);
    expect(rbac.calls.every((c) => c.req.resource.type === 'doc' && c.req.resource.id === 'd1')).to.equal(true);
    expect(resolver.ancestorCalls).to.have.length(1);
    expect(cache.size).to.be.greaterThan(0);
  });

  it('an unknown at denies every permission', async () => {
    const rbac = new StaticModel('rbac', { vote: P() });
    const resolver = new FakeScopeResolver(['doc'], {});
    const s = await make({ models: [rbac], scopeResolvers: [resolver] }).summary(alice, { type: 'doc', id: 'gone' });
    expect(s.permissions).to.deep.equal([]);
  });

  it('a check that throws skips that permission and is logged', async () => {
    const rbac = new StaticModel('rbac', { vote: P() });
    const s = await make({ models: [rbac], registry: new ThrowingRegistry('doc:read') }).summary(alice);
    expect(names(s)).to.deep.equal(['doc:delete', 'doc:write', 'org:view']);
    expect(log.at('error').some((e) => e.message.includes('registry down'))).to.equal(true);
  });

  it('a malformed at is refused', async () => {
    const a = make();
    for (const at of [null, 'doc', { id: 'x' }, { type: 'doc', id: 3 }]) {
      let error: unknown;
      try {
        await a.summary(alice, at as never);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(AuthzConfigError);
    }
  });

  it('the checks of a summary are not audited', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P() } }) });
    await make({ models: [rbac] }).summary(alice);
    expect(audit.entries).to.deep.equal([]);
  });

  it('a denial a summary check decided is audited by the first real check that reuses it in the same request; an allow is not (I1, review P1)', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P() } }) });
    const a = make({ models: [rbac] });
    const cache = new Map<string, unknown>();
    await a.summary(alice, GLOBAL, { cache });
    const calls = rbac.calls.length;
    expect((await a.check({ principal: alice, permission: 'doc:read', resource: GLOBAL }, { cache })).allowed).to.equal(true);
    for (let i = 0; i < 2; i++) expect((await a.check({ principal: alice, permission: 'doc:delete', resource: GLOBAL }, { cache })).allowed).to.equal(false);
    // Served from the request scope, not evaluated again.
    expect(rbac.calls).to.have.length(calls);
    expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'user', id: 'alice' }, permission: 'doc:delete', resource: { type: '$global' }, reason: 'no_access' }]);
  });

  it('one clock reading per summary call: summarize and every check see the same now (M1)', async () => {
    let ticks = 0;
    const ticking = () => new Date(Date.UTC(2026, 9, 1) + ticks++);
    const rbac = new SummaryModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P(), 'doc:write': P() } }) }, () => ({
      model: 'rbac',
      permissions: [
        { name: 'doc:read', conditional: false },
        { name: 'doc:write', conditional: false },
        { name: 'org:view', conditional: false },
      ],
    }));
    await make({ models: [rbac], clock: ticking }).summary(alice);
    const instants = [rbac.summaries[0].ctx.now, ...rbac.calls.map((c) => c.req.env!.now as Date)].map((d) => d.getTime());
    expect(instants).to.have.length(4);
    expect(new Set(instants).size).to.equal(1);
  });

  it('a model summary keeps only read, write and hide under fields (M3)', async () => {
    const rbac = new SummaryModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P() } }) }, () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false, fields: { read: ['title'], hide: ['secret'], token: 'abc', note: ['x'] } }] }));
    const s = await make({ models: [rbac] }).summary(alice);
    expect(s.models[0].permissions[0].fields).to.deep.equal({ read: ['title'], hide: ['secret'] });
    expect(deepFrozen(s)).to.equal(true);
  });

  it(`checks at most MAX_SUMMARY_PERMISSIONS (${MAX_SUMMARY_PERMISSIONS}) permissions and warns when there are more`, async function () {
    this.timeout(60000);
    const many = registryOf(Array.from({ length: MAX_SUMMARY_PERMISSIONS + 1 }, (_, i) => ({ name: `p:a${String(i).padStart(5, '0')}`, types: ['p'] })));
    const a = make({ registry: many, models: [new StaticModel('rbac', { vote: P() })] });
    const s = await a.summary(alice);
    expect(s.permissions).to.have.length(MAX_SUMMARY_PERMISSIONS);
    expect(s.permissions[0].name).to.equal('p:a00000');
    expect(log.at('warn').some((e) => e.message.includes(String(MAX_SUMMARY_PERMISSIONS)))).to.equal(true);
  });

  it('summarize runs with the principal the models run with (the narrowed delegate under inherit)', async () => {
    const rbac = new SummaryModel('rbac', { vote: table('rbac', { bob: { 'doc:read': P() } }) }, () => ({ model: 'rbac', permissions: [{ name: 'doc:read', conditional: false }] }));
    const agent = principal('agent', 'bot', { onBehalfOf: bob, delegation: 'inherit' });
    const s = await make({ models: [rbac] }).summary(agent);
    expect(s.principal).to.deep.equal({ type: 'agent', id: 'bot' });
    expect(rbac.summaries[0].principal.id).to.equal('bob');
    expect(names(s)).to.deep.equal(['doc:read']);
  });
});

describe('Authorizer.covers', () => {
  const setup = (grants: Grants, options: Partial<AuthorizerOptions> = {}, capabilities: StaticModelOptions['capabilities'] = {}) => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', grants), capabilities });
    return { rbac, a: make({ models: [rbac], ...options }) };
  };

  it('holder strictly above target ⇒ true; the reverse ⇒ false', async () => {
    const { a } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P() } });
    expect(await a.covers(alice, bob)).to.equal(true);
    expect(await a.covers(bob, alice)).to.equal(false);
  });

  it('equal sets ⇒ false (strict)', async () => {
    const { a } = setup({ alice: { 'doc:read': P() }, bob: { 'doc:read': P() } });
    expect(await a.covers(alice, bob)).to.equal(false);
    expect(await a.covers(bob, alice)).to.equal(false);
  });

  it('disjoint sets ⇒ false both ways', async () => {
    const { a } = setup({ alice: { 'doc:read': P() }, bob: { 'org:view': P() } });
    expect(await a.covers(alice, bob)).to.equal(false);
    expect(await a.covers(bob, alice)).to.equal(false);
  });

  it('an unconditional entry covers a conditional one, not the reverse', async () => {
    const { a } = setup({ alice: { 'doc:read': P(TRUE) }, bob: { 'doc:read': P(isPublic) } });
    expect(await a.covers(alice, bob)).to.equal(true);
    expect(await a.covers(bob, alice)).to.equal(false);
  });

  it('structurally equal conditional entries cover each other; the holder needs one more entry to be strictly above', async () => {
    const { a } = setup({ alice: { 'doc:read': P(isPublic), 'doc:write': P() }, bob: { 'doc:read': P(isPublic) } });
    expect(await a.covers(alice, bob)).to.equal(true);
    expect(await a.covers(bob, alice)).to.equal(false);
  });

  it('conditions are bound for each principal: an owner condition never covers another principal’s', async () => {
    const { a } = setup({ alice: { 'doc:read': P(owner), 'doc:write': P() }, bob: { 'doc:read': P(owner) } });
    expect(await a.covers(alice, bob)).to.equal(false);
  });

  it('equal residuals with a relation or native node never cover', async () => {
    const { a } = setup({ alice: { 'doc:read': P(member), 'doc:write': P(acl), 'org:view': P() }, bob: { 'doc:read': P(member) }, carol: { 'doc:write': P(acl) } }, {}, { residuals: [...CORE_FILTER_OPS, 'native:acl'] });
    expect(await a.covers(alice, bob)).to.equal(false);
    expect(await a.covers(alice, principal('user', 'carol'))).to.equal(false);
  });

  it('the target fields must be inside the holder fields, read and write', async () => {
    const read = (r: string[]) => P(TRUE, { fields: { read: r } });
    const write = (w: string[]) => P(TRUE, { fields: { write: w } });
    const cases: [Partial<Vote>, Partial<Vote>, boolean][] = [
      [read(['title']), read(['title', 'body']), false],
      [read(['*']), read(['title']), true],
      [write(['title']), write(['title', 'body']), false],
      [write(['*']), write(['title']), true],
    ];
    for (const [holder, target, expected] of cases) {
      const { a } = setup({ alice: { 'doc:read': holder, 'org:view': P() }, bob: { 'doc:read': target } });
      expect(await a.covers(alice, bob)).to.equal(expected);
    }
  });

  it('wider fields alone make the holder strictly above', async () => {
    const { a } = setup({ alice: { 'doc:read': P(TRUE, { fields: { read: ['*'] } }) }, bob: { 'doc:read': P(TRUE, { fields: { read: ['title'] } }) } });
    expect(await a.covers(alice, bob)).to.equal(true);
    expect(await a.covers(bob, alice)).to.equal(false);
  });

  it('SYSTEM: a SYSTEM target is never covered; a SYSTEM holder covers every target the gate admits', async () => {
    const { a, rbac } = setup({ alice: { 'doc:read': P() } });
    expect(await a.covers(SYSTEM, alice)).to.equal(true);
    expect(await a.covers(SYSTEM, UNATTENDED)).to.equal(false);
    expect(await a.covers(SYSTEM, principal('system', 'system'))).to.equal(false);
    expect(await a.covers(SYSTEM, { ...SYSTEM } as Principal)).to.equal(false);
    expect(await a.covers(SYSTEM, principal('agent', 'bot', { onBehalfOf: SYSTEM }))).to.equal(false);
    expect(await a.covers(SYSTEM, SYSTEM)).to.equal(false);
    expect(await a.covers(alice, SYSTEM)).to.equal(false);
    expect(rbac.calls).to.have.length(0);
  });

  it('UNATTENDED or forged holders cover nothing; an UNATTENDED target is never covered', async () => {
    const { a } = setup({ alice: { 'doc:read': P() }, bob: {} });
    for (const holder of [UNATTENDED, { ...SYSTEM }, principal('system', 'system'), undefined]) {
      expect(await a.covers(holder as Principal, bob)).to.equal(false);
    }
    expect(await a.covers(alice, UNATTENDED)).to.equal(false);
    expect(await a.covers(bob, UNATTENDED)).to.equal(false);
  });

  it('a target the principal gate or the onBehalfOf resolution refuses is never covered, without any check (review P2)', async () => {
    const { a, rbac } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P() } });
    const deep = principal('agent', 'a1', { onBehalfOf: principal('agent', 'a2', { onBehalfOf: principal('agent', 'a3', { onBehalfOf: bob }) }) });
    const cyclic: { -readonly [K in keyof Principal]: Principal[K] } = principal('agent', 'loop');
    cyclic.onBehalfOf = cyclic;
    const targets: unknown[] = [undefined, null, 42, 'user:bob', UNATTENDED, { ...SYSTEM }, { ...UNATTENDED }, principal('system', 'system'), principal('unattended', 'x'), { type: 'user' }, principal('agent', 'bot', { onBehalfOf: SYSTEM }), principal('agent', 'bot', { onBehalfOf: UNATTENDED }), principal('agent', 'bot', { onBehalfOf: principal('system', 'x') }), principal('agent', 'bot', { onBehalfOf: SYSTEM, delegation: 'inherit' }), principal('agent', 'bot', { onBehalfOf: principal('agent', 'b2', { onBehalfOf: SYSTEM }) }), principal('agent', 'bot', { onBehalfOf: 'user:bob' as never }), deep, cyclic];
    for (const target of targets) expect(await a.covers(alice, target as Principal), String((target as Principal | undefined)?.id ?? target)).to.equal(false);
    expect(rbac.calls).to.have.length(0);
    // The same holder covers an admitted target, so the falses above come from the refusal.
    expect(await a.covers(alice, bob)).to.equal(true);
  });

  it('a holder the onBehalfOf resolution refuses covers nothing, without any check', async () => {
    const { a, rbac } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: {} });
    const deep = principal('agent', 'a1', { onBehalfOf: principal('agent', 'a2', { onBehalfOf: principal('agent', 'a3', { onBehalfOf: alice }) }) });
    for (const holder of [principal('agent', 'bot', { onBehalfOf: SYSTEM }), principal('agent', 'bot', { onBehalfOf: SYSTEM, delegation: 'inherit' }), deep]) {
      expect(await a.covers(holder, bob)).to.equal(false);
    }
    expect(rbac.calls).to.have.length(0);
  });

  it('a target that reads as a user at the gate and as system in its checks is not covered', async () => {
    const { a } = setup({ alice: { 'doc:read': P(), 'doc:write': P() } });
    let reads = 0;
    const target: Record<string, unknown> = { ...principal('user', 'mallory') };
    Object.defineProperty(target, 'type', { get: () => (reads++ === 0 ? 'user' : 'system'), enumerable: true });
    expect(await a.covers(alice, target as unknown as Principal)).to.equal(false);
  });

  it('one clock reading per covers call: holder and target bind env.now at the same instant (M1)', async () => {
    let ticks = 0;
    const ticking = () => new Date(Date.UTC(2026, 9, 1) + ticks++);
    const fresh: ResourceFilter = { op: 'cmp', field: 'expires', cmp: 'gt', value: { ref: 'env.now' } };
    const { a } = setup({ alice: { 'doc:read': P(fresh), 'doc:write': P() }, bob: { 'doc:read': P(fresh) } }, { clock: ticking });
    expect(await a.covers(alice, bob)).to.equal(true);
  });

  it('a denial a covers check decided is audited by the first real check that reuses it in the same request (I1)', async () => {
    const { a } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P() } });
    const cache = new Map<string, unknown>();
    expect(await a.covers(alice, bob, GLOBAL, { cache })).to.equal(true);
    expect(audit.entries).to.deep.equal([]);
    for (let i = 0; i < 2; i++) expect((await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache })).allowed).to.equal(false);
    expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'user', id: 'bob' }, permission: 'doc:write', resource: { type: '$global' }, reason: 'no_access' }]);
  });

  it('comparison limits fail closed: a residual too deep to compare never covers (COMPARE_DEPTH)', async () => {
    const leaf = (i: number): ResourceFilter => ({ op: 'cmp', field: `f${i}`, cmp: 'eq', value: i });
    const nest = (levels: number): ResourceFilter => {
      let f: ResourceFilter = leaf(0);
      for (let i = 1; i <= levels; i++) f = { op: i % 2 === 0 ? 'and' : 'or', args: [leaf(i), f] } as ResourceFilter;
      return f;
    };
    for (const [levels, expected] of [
      [20, true],
      [150, false],
    ] as const) {
      const { a } = setup({ alice: { 'doc:read': P(nest(levels)), 'doc:write': P() }, bob: { 'doc:read': P(nest(levels)) } });
      const d = await a.check({ principal: bob, permission: 'doc:read', resource: GLOBAL });
      expect(d.allowed && d.residual.op !== 'true').to.equal(true);
      expect(await a.covers(alice, bob), `${levels} levels`).to.equal(expected);
    }
  });

  it('comparison limits fail closed: a residual too large to compare never covers (COMPARE_NODES)', async function () {
    this.timeout(60000);
    const scopes = (model: number, n: number): ResourceFilter => ({ op: 'under', scopes: Array.from({ length: n }, (_, i) => ({ type: 'folder', id: `m${model}-${i}` })) });
    for (const [n, expected] of [
      [10, true],
      [9000, false],
    ] as const) {
      const models = [0, 1, 2, 3].map((k) => new StaticModel(`m${k}`, { vote: table(`m${k}`, { alice: { 'doc:read': P(scopes(k, n)), ...(k === 0 ? { 'doc:write': P() } : {}) }, bob: { 'doc:read': P(scopes(k, n)) } }), capabilities: { effects: ['permit'] } }));
      const a = make({ models, combine: { default: { algorithm: 'permit-overrides' } } });
      const d = await a.check({ principal: bob, permission: 'doc:read', resource: GLOBAL });
      expect(d.allowed && d.residual.op === 'or' && d.residual.args.length === 4, `${n} scopes`).to.equal(true);
      expect(await a.covers(alice, bob), `${n} scopes`).to.equal(expected);
    }
  });

  it('comparison limits fail closed: a field comparison over its budget makes covers false and is logged', async () => {
    const holderRead = Array.from({ length: 200 }, (_, i) => `a${i}.*`);
    const targetRead = Array.from({ length: 200 }, (_, i) => `*.b${i}`);
    const { a } = setup({ alice: { 'doc:read': P(TRUE, { fields: { read: holderRead } }), 'doc:write': P() }, bob: { 'doc:read': P(TRUE, { fields: { read: targetRead } }) } });
    expect((await a.check({ principal: bob, permission: 'doc:read', resource: GLOBAL })).allowed).to.equal(true);
    expect((await a.check({ principal: alice, permission: 'doc:read', resource: GLOBAL })).allowed).to.equal(true);
    expect(await a.covers(alice, bob)).to.equal(false);
    expect(log.at('error').some((e) => e.message.includes('covers is false') && e.message.includes('too complex'))).to.equal(true);
  });

  it('B26: an ABAC deny policy on the holder counts', async () => {
    const grants: Grants = { admin: { 'doc:read': P(), 'doc:write': P(), 'doc:delete': P(), 'org:view': P() }, bob: { 'doc:read': P(), 'doc:delete': P() } };
    const admin = principal('user', 'admin', { attributes: { dept: 'ops' } });
    const rbac = new StaticModel('rbac', { vote: table('rbac', grants) });
    const abac = new StaticModel('abac', {
      vote: (req: DecisionRequest) => ({ model: 'abac', permitWhen: FALSE, denyWhen: req.permission === 'doc:delete' && req.principal.attributes.dept === 'ops' ? TRUE : FALSE, cacheable: true }),
    });
    expect(await make({ models: [rbac] }).covers(admin, bob)).to.equal(true);
    expect(await make({ models: [rbac, abac] }).covers(admin, bob)).to.equal(false);
  });

  it('B26: an ABAC permit on the target counts', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P() } }) });
    const abac = new StaticModel('abac', { vote: table('abac', { bob: { 'org:view': P() } }) });
    const options = { combine: { default: { algorithm: 'permit-overrides' } } };
    expect(await make({ models: [rbac], ...options }).covers(alice, bob)).to.equal(true);
    expect(await make({ models: [rbac, abac], ...options }).covers(alice, bob)).to.equal(false);
  });

  it('B26: a ceiling on the holder narrows what it covers', async () => {
    const { a } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:write': P() } });
    expect(await a.covers(alice, bob)).to.equal(true);
    const narrowed = principal('user', 'alice', { ceiling: { permissions: ['doc:read'] } });
    expect(await a.covers(narrowed, bob)).to.equal(false);
  });

  it('a check that throws makes covers false (fail closed) and is logged', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P() } }) });
    expect(await make({ models: [rbac] }).covers(alice, bob)).to.equal(true);
    expect(await make({ models: [rbac], registry: new ThrowingRegistry('org:view') }).covers(alice, bob)).to.equal(false);
    expect(log.at('error').some((e) => e.message.includes('registry down'))).to.equal(true);
  });

  it('a typed at compares the permissions checkable on its type, sharing one scope', async () => {
    const resolver = new FakeScopeResolver(['doc'], { 'doc:d1': null });
    const { a, rbac } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P(), 'org:view': P() } }, { scopeResolvers: [resolver] });
    expect(await a.covers(alice, bob, { type: 'doc', id: 'd1' })).to.equal(true);
    expect(rbac.calls.every((c) => c.req.permission !== 'org:view')).to.equal(true);
    expect(resolver.ancestorCalls).to.have.length(1);
    expect(await a.covers(alice, bob)).to.equal(false);
  });

  it('a malformed at is refused', async () => {
    let error: unknown;
    try {
      await make().covers(alice, bob, { id: 'x' } as never);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(AuthzConfigError);
  });

  it('the checks of covers are not audited', async () => {
    const { a } = setup({ alice: { 'doc:read': P(), 'doc:write': P() }, bob: { 'doc:read': P() } });
    await a.covers(alice, bob);
    expect(audit.entries).to.deep.equal([]);
  });

  it(`more than MAX_SUMMARY_PERMISSIONS (${MAX_SUMMARY_PERMISSIONS}) permissions ⇒ false without checking, with a warning`, async () => {
    const many = registryOf(Array.from({ length: MAX_SUMMARY_PERMISSIONS + 1 }, (_, i) => ({ name: `p:a${i}`, types: ['p'] })));
    const rbac = new StaticModel('rbac', { vote: table('rbac', { alice: { 'p:a0': P() } }) });
    expect(await make({ registry: many, models: [rbac] }).covers(alice, bob)).to.equal(false);
    expect(rbac.calls).to.have.length(0);
    expect(log.at('warn').some((e) => e.message.includes(String(MAX_SUMMARY_PERMISSIONS)))).to.equal(true);
  });

  it('stops checking once a target entry is not covered', async () => {
    const grants: Grants = { bob: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p:a${String(i).padStart(2, '0')}`, P()])) };
    const many = registryOf(Array.from({ length: 40 }, (_, i) => ({ name: `p:a${String(i).padStart(2, '0')}`, types: ['p'] })));
    const rbac = new StaticModel('rbac', { vote: table('rbac', grants) });
    expect(await make({ registry: many, models: [rbac] }).covers(alice, bob)).to.equal(false);
    expect(rbac.calls.length).to.be.lessThan(80);
  });
});

/** deny-overrides that throws while `fails` says so. */
const flaky = (fails: (votes: readonly Vote[]) => boolean) => ({
  name: 'flaky',
  combine: (votes: readonly Vote[]) => {
    if (fails(votes)) throw new Error('boom');
    return new DenyOverrides().combine(votes);
  },
});

describe('Authorizer.covers and summary: decisions that rest on an engine fault (C2)', () => {
  // alice: doc:read, doc:delete; bob: doc:read, doc:write. Without a fault covers(alice, bob) is false.
  const grants: Grants = { alice: { 'doc:read': P(), 'doc:delete': P() }, bob: { 'doc:read': P(), 'doc:write': P() } };
  const bobWithoutWrite: Grants = { ...grants, bob: { 'doc:read': P() } };
  const bobWrite = (req: DecisionRequest): boolean => req.principal.id === 'bob' && req.permission === 'doc:write';
  const tier: ResourceFilter = { op: 'cmp', field: 'tier', cmp: 'eq', value: { ref: 'scope.$global.tier' } };
  const store = (get: () => Promise<Record<string, unknown>>): Partial<AuthorizerOptions> => ({ scopeAttributes: { store: { get, version: () => Promise.resolve('') } } });

  it('R1: a target vote that throws makes covers false; the same target without that grant is covered', async () => {
    const faulty = new StaticModel('rbac', {
      vote: (req: DecisionRequest) => {
        if (bobWrite(req)) throw new Error('db down');
        return table('rbac', grants)(req);
      },
    });
    const a = make({ models: [faulty] });
    expect((await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL })).reason?.code).to.equal('model_error');
    expect(await a.covers(alice, bob)).to.equal(false);
    expect(await make({ models: [new StaticModel('rbac', { vote: table('rbac', bobWithoutWrite) })] }).covers(alice, bob)).to.equal(true);
  });

  it('R2: a target vote that never settles makes covers false', async () => {
    const hanging = new StaticModel('rbac', { vote: ((req: DecisionRequest) => (bobWrite(req) ? new Promise(() => {}) : table('rbac', grants)(req))) as never });
    expect(await make({ models: [hanging], config: { modelTimeoutMs: 50 } }).covers(alice, bob)).to.equal(false);
    // The vote's own time limit decides, not the call's deadline.
    expect(log.at('error').some((e) => e.message.includes('target check of doc:write rests on an engine fault'))).to.equal(true);
  });

  it('R3: a fault masked by another reason (permit-overrides, the granting model throws) still makes covers false', async () => {
    const m1 = new StaticModel('m1', { vote: (req: DecisionRequest) => ({ ...table('m1', bobWithoutWrite)(req), reason: { code: 'no_access' } } as Vote), capabilities: { effects: ['permit'] } });
    const m2 = (throws: boolean) =>
      new StaticModel('m2', {
        vote: (req: DecisionRequest) => {
          if (throws && bobWrite(req)) throw new Error('db down');
          return { model: 'm2', permitWhen: FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        },
        capabilities: { effects: ['permit'] },
      });
    const combine = { default: { algorithm: 'permit-overrides' } } as const;
    const a = make({ models: [m1, m2(true)], combine });
    expect((await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL })).reason?.code).to.equal('no_access');
    expect(await a.covers(alice, bob)).to.equal(false);
    expect(await make({ models: [m1, m2(false)], combine }).covers(alice, bob)).to.equal(true);
  });

  it('a combinator that throws for a target check makes covers false', async () => {
    // Only bob's doc:write is conditional, so the combinator fails for that check alone.
    const throwsOnCmp = flaky((votes) => votes.some((v) => v.permitWhen.op === 'cmp'));
    const rbac = new StaticModel('rbac', { vote: table('rbac', { ...grants, bob: { 'doc:read': P(), 'doc:write': P(isPublic) } }) });
    const options = { combinators: [throwsOnCmp as never], combine: { default: { algorithm: 'flaky' } } };
    expect(await make({ models: [rbac], ...options }).covers(alice, bob)).to.equal(false);
    expect(await make({ models: [new StaticModel('rbac', { vote: table('rbac', bobWithoutWrite) })], ...options }).covers(alice, bob)).to.equal(true);
  });

  it('a scope attribute load that rejects or times out in the binder makes covers false', async () => {
    const rbac = new StaticModel('rbac', { vote: table('rbac', { ...grants, bob: { 'doc:read': P(), 'doc:write': P(tier) } }) });
    expect(await make({ models: [rbac], ...store(() => Promise.reject(new Error('store down'))) }).covers(alice, bob)).to.equal(false);
    expect(await make({ models: [rbac], config: { modelTimeoutMs: 50 }, ...store(() => new Promise(() => {})) }).covers(alice, bob)).to.equal(false);
    // A store that answers without the attribute: bob's doc:write is really denied, so alice covers him.
    expect(await make({ models: [rbac], ...store(() => Promise.resolve({})) }).covers(alice, bob)).to.equal(true);
  });

  it('a model that catches a failed or timed-out ctx.attributes and votes no makes covers false', async () => {
    const reading = (get: () => Promise<Record<string, unknown>>) => {
      const rbac = new StaticModel('rbac', {
        vote: (async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (!bobWrite(req)) return table('rbac', grants)(req);
          const attrs = await ctx.attributes(GLOBAL).catch(() => null);
          return { model: 'rbac', permitWhen: attrs?.tier === 'gold' ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        }) as never,
      });
      return make({ models: [rbac], config: { modelTimeoutMs: 50 }, ...store(get) });
    };
    expect(await reading(() => Promise.reject(new Error('store down'))).covers(alice, bob)).to.equal(false);
    expect(await reading(() => new Promise(() => {})).covers(alice, bob)).to.equal(false);
    expect(await reading(() => Promise.resolve({ tier: 'basic' })).covers(alice, bob)).to.equal(true);
  });

  it('a target decision resting on a faulted nested ctx.check makes covers false', async () => {
    const carol = principal('user', 'carol');
    const nesting = (carolThrows: boolean) =>
      new StaticModel('rbac', {
        vote: (async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'carol') {
            if (carolThrows) throw new Error('db down');
            return { model: 'rbac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true } as Vote;
          }
          if (!bobWrite(req)) return table('rbac', grants)(req);
          const nested = await ctx.check({ principal: carol, permission: 'doc:delete', resource: GLOBAL });
          return { model: 'rbac', permitWhen: nested.allowed ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        }) as never,
      });
    expect(await make({ models: [nesting(true)] }).covers(alice, bob)).to.equal(false);
    expect(await make({ models: [nesting(false)] }).covers(alice, bob)).to.equal(true);
  });

  it('a faulted holder check makes covers false too (conservative)', async () => {
    const holderFaults = (throws: boolean) =>
      new StaticModel('rbac', {
        vote: (req: DecisionRequest) => {
          if (throws && req.principal.id === 'alice' && req.permission === 'doc:delete') throw new Error('db down');
          return table('rbac', { alice: { 'doc:read': P(), 'doc:write': P(), 'doc:delete': P() }, bob: { 'doc:read': P() } })(req);
        },
      });
    expect(await make({ models: [holderFaults(false)] }).covers(alice, bob)).to.equal(true);
    expect(await make({ models: [holderFaults(true)] }).covers(alice, bob)).to.equal(false);
  });

  it('a faulted decision is never cached: a later check or covers in the same request evaluates it again', async () => {
    let fail = true;
    const a = make({ models: [new StaticModel('rbac', { vote: table('rbac', grants) })], combinators: [flaky(() => fail) as never], combine: { default: { algorithm: 'flaky' } } });
    const cache = new Map<string, unknown>();
    expect((await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache })).reason?.code).to.equal('model_error');
    fail = false;
    expect((await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache })).allowed).to.equal(true);

    const scope = new Map<string, unknown>();
    fail = true;
    await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache: scope });
    fail = false;
    // bob's doc:write is evaluated again (allowed), not read as the cached denial, so alice does not cover him.
    expect(await a.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);
  });

  it('R4: a degraded load the model memoised in ctx.cache earlier in the request makes covers false', async () => {
    const memoising = (get: () => Promise<Record<string, unknown>>) => {
      const rbac = new StaticModel('rbac', {
        vote: (async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (!bobWrite(req)) return table('rbac', grants)(req);
          if (!ctx.cache.has('tier'))
            ctx.cache.set(
              'tier',
              await ctx.attributes(GLOBAL).then(
                (a) => a?.tier,
                () => undefined,
              ),
            );
          return { model: 'rbac', permitWhen: ctx.cache.get('tier') === 'gold' ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        }) as never,
      });
      return make({ models: [rbac], config: { modelTimeoutMs: 50 }, ...store(get) });
    };
    const write = { principal: bob, permission: 'doc:write', resource: GLOBAL } as const;

    const hung = memoising(() => new Promise(() => {}));
    const scope = new Map<string, unknown>();
    expect((await hung.check(write, { cache: scope })).allowed).to.equal(false);
    expect(await hung.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

    const basic = memoising(() => Promise.resolve({ tier: 'basic' }));
    const control = new Map<string, unknown>();
    expect((await basic.check(write, { cache: control })).allowed).to.equal(false);
    expect(await basic.covers(alice, bob, GLOBAL, { cache: control })).to.equal(true);
  });

  it('a rejected ctx.check the model memoised earlier in the request makes covers false', async () => {
    const carol = principal('user', 'carol');
    const d1: ResourceRef = { type: 'doc', id: 'd1' };
    class Resolver extends FakeScopeResolver {
      constructor(private readonly down: boolean) {
        super(['doc'], { 'doc:d1': null });
      }
      ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
        return this.down ? Promise.reject(new Error('resolver down')) : super.ancestors(ref);
      }
    }
    const memoising = (down: boolean) => {
      const rbac = new StaticModel('rbac', {
        vote: (async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'carol') return { model: 'rbac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true } as Vote;
          if (!bobWrite(req)) return table('rbac', grants)(req);
          if (!ctx.cache.has('carol'))
            ctx.cache.set(
              'carol',
              await ctx.check({ principal: carol, permission: 'doc:delete', resource: d1 }).then(
                (d) => d.allowed,
                () => false,
              ),
            );
          return { model: 'rbac', permitWhen: ctx.cache.get('carol') === true ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        }) as never,
      });
      return make({ models: [rbac], scopeResolvers: [new Resolver(down)] });
    };
    const write = { principal: bob, permission: 'doc:write', resource: GLOBAL } as const;

    const failing = memoising(true);
    const scope = new Map<string, unknown>();
    expect((await failing.check(write, { cache: scope })).allowed).to.equal(false);
    expect(await failing.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

    const working = memoising(false);
    const control = new Map<string, unknown>();
    expect((await working.check(write, { cache: control })).allowed).to.equal(false);
    expect(await working.covers(alice, bob, GLOBAL, { cache: control })).to.equal(true);
  });

  it('a faulted (resolved, not rejected) ctx.check the model memoised earlier in the request makes covers false', async () => {
    const carol = principal('user', 'carol');
    const memoising = (carolFaults: boolean) => {
      const rbac = new StaticModel('rbac', {
        vote: (async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'carol') {
            if (carolFaults) throw new Error('db down');
            return { model: 'rbac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true } as Vote;
          }
          if (!bobWrite(req)) return table('rbac', grants)(req);
          if (!ctx.cache.has('carol')) ctx.cache.set('carol', (await ctx.check({ principal: carol, permission: 'doc:delete', resource: GLOBAL })).allowed);
          return { model: 'rbac', permitWhen: ctx.cache.get('carol') === true ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        }) as never,
      });
      return make({ models: [rbac] });
    };
    const write = { principal: bob, permission: 'doc:write', resource: GLOBAL } as const;

    const faulting = memoising(true);
    const scope = new Map<string, unknown>();
    expect((await faulting.check(write, { cache: scope })).allowed).to.equal(false);
    expect(await faulting.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

    const healthy = memoising(false);
    const control = new Map<string, unknown>();
    expect((await healthy.check(write, { cache: control })).allowed).to.equal(false);
    expect(await healthy.covers(alice, bob, GLOBAL, { cache: control })).to.equal(true);
  });

  it('summary leaves out an allowed permission whose decision rests on a fault, and logs it', async () => {
    const bad = new StaticModel('bad', {
      vote: (req: DecisionRequest) => {
        if (req.permission === 'doc:read') throw new Error('db down');
        return { model: 'bad', permitWhen: FALSE, denyWhen: FALSE, cacheable: true } as Vote;
      },
      capabilities: { effects: ['permit'] },
    });
    const good = new StaticModel('good', { vote: table('good', { alice: { 'doc:read': P(), 'doc:write': P() } }), capabilities: { effects: ['permit'] } });
    const a = make({ models: [bad, good], combine: { default: { algorithm: 'permit-overrides' } } });
    expect((await a.check({ principal: alice, permission: 'doc:read', resource: GLOBAL })).allowed).to.equal(true);
    log.entries.length = 0;
    expect(names(await a.summary(alice))).to.deep.equal(['doc:write']);
    expect(log.at('error').some((e) => e.message.includes('fault') && e.message.includes('doc:read'))).to.equal(true);
  });
});

describe('Authorizer.covers and summary: one deadline per call (M2)', () => {
  const many = registryOf(Array.from({ length: 200 }, (_, i) => ({ name: `p:a${String(i).padStart(3, '0')}`, types: ['p'] })));
  const sorted = many
    .all()
    .map((d) => d.name)
    .sort();
  const slow = () => new StaticModel('rbac', { vote: table('rbac', { alice: Object.fromEntries(sorted.map((n) => [n, P()])) }), delayMs: 30 });

  it('covers past 4 × modelTimeoutMs is false without waiting for the remaining checks, and is logged', async function () {
    this.timeout(20000);
    const started = Date.now();
    expect(await make({ registry: many, models: [slow()], config: { modelTimeoutMs: 100 } }).covers(alice, bob)).to.equal(false);
    expect(Date.now() - started).to.be.lessThan(3250);
    expect(log.at('error').some((e) => e.message.includes('400 ms'))).to.equal(true);
    // The same call under a longer limit finishes and covers.
    expect(await make({ registry: many, models: [slow()], config: { modelTimeoutMs: 2000 } }).covers(alice, bob)).to.equal(true);
  });

  it('summary past 4 × modelTimeoutMs returns the permissions checked so far, leaves out the rest and logs it', async function () {
    this.timeout(20000);
    const started = Date.now();
    const s = await make({ registry: many, models: [slow()], config: { modelTimeoutMs: 100 } }).summary(alice);
    expect(Date.now() - started).to.be.lessThan(3250);
    expect(s.permissions.length).to.be.greaterThan(0);
    expect(s.permissions.length).to.be.lessThan(200);
    expect(names(s)).to.deep.equal(sorted.slice(0, s.permissions.length));
    expect(log.at('error').some((e) => e.message.includes('400 ms') && e.message.includes(`${200 - s.permissions.length} permission`))).to.equal(true);
    expect(deepFrozen(s)).to.equal(true);
    expect((await make({ registry: many, models: [slow()], config: { modelTimeoutMs: 2000 } }).summary(alice)).permissions).to.have.length(200);
  });
});
