import { AuthzConfigError, DefaultConditionCompiler, FALSE, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, NativeFilter, PermissionInput, Principal, ResourceFilter, ResourceRef, RuleDef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, RbacModel, RuleRowsError, createRbacExtensions, MAX_LIST_ARGS_LENGTH, MAX_LIST_ITEMS, parseRbacListArgs, rbacThresholdArgs, ruleStoreParts, rbacAssignmentArgsV2, rbacAssignmentExtension } from '../../src/index.js';
import type { GrantDef, LadderDef, RbacAssignmentArgsV2, RbacThresholdArgs, RoleDef, RuleStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const r = (type: string, id: string): ResourceRef => ({ type, id });
const [O1, O2, P1, P2, P3, P4] = [r('org', 'o1'), r('org', 'o2'), r('project', 'p1'), r('project', 'p2'), r('project', 'p3'), r('project', 'p4')];
const FILES = [
  { ref: r('file', 'f1'), parent: P1, name: 'notes' },
  { ref: r('file', 'f2'), parent: P1, name: 'release/1' },
  { ref: r('file', 'f3'), parent: P2, name: 'plan' },
  { ref: r('file', 'f4'), parent: P3, name: 'release/2' },
  // A project in no org: rules that read scope.org.* are indeterminate there (B39).
  { ref: r('file', 'f5'), parent: P4, name: 'loose' },
];
const FILE = { type: 'file' };
const PW = ['project', 'org'];

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });
const rule = (def: Omit<RuleDef, 'source'>): RuleDef => ({ ...def, source: 'test' });

const PERMISSIONS: PermissionInput[] = ['file:read', 'file:edit', 'file:admin', 'inspect:view', 'repo:read'].map((name) => ({ name, types: ['org', 'project', 'file'] }));
const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'org', roles: ['org.guest', 'org.member', 'org.admin'] },
];
const ROLES: RoleDef[] = [role('viewer', ['file:read', { permission: 'inspect:view', requiresTag: 'inspect' }, { permission: 'repo:read', grantedAt: PW }], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', ['file:admin'], { ladder: 'project' }), role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org', subjectSet: true }), role('org.admin', [], { ladder: 'org', implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect'] }] }), role('team.lead', [], { implies: [{ role: 'editor', at: 'descendants', tags: ['inspect'] }] }), role('support', [], { implies: [{ role: 'editor', at: 'self-and-descendants', bypass: ['restrict', 'cap'] }] })];

function registry() {
  const reg = new PermissionRegistryImpl();
  reg.register(PERMISSIONS, 'test');
  reg.freeze();
  return reg;
}

const scopes = new FakeScopeResolver({
  types: ['org', 'project', 'file'],
  nodes: [{ ref: O1, attributes: { owner: 'alice', level: 3, shape: { a: 1 }, policies: { locked: true } } }, { ref: O2, attributes: { owner: 'bob', level: 1, depth: 1, policies: { locked: false } } }, { ref: P1, parent: O1 }, { ref: P2, parent: O1 }, { ref: P3, parent: O2 }, { ref: P4 }, ...FILES.map((f) => ({ ref: f.ref, parent: f.parent }))],
});

interface Built {
  readonly model: RbacModel;
  ctx(now?: Date): EvaluationContext;
}

/** A store that is not in memory over `defs`: its rules are DB rules, read per path. */
const remote = (defs: readonly Omit<RuleDef, 'source'>[]): RuleStore => {
  const inner = new ConfigRuleStore(defs.map(rule));
  return { name: 'remote', forPath: (path, at) => inner.forPath(path, at), version: () => inner.version() };
};

/** `db`: a second rule store beside the config one (design §8.5: ConfigRuleStore and DbRuleStore). */
async function build(rows: readonly Assignment[], rules: readonly Omit<RuleDef, 'source'>[] | RuleStore, opts: { readonly lists?: boolean; readonly db?: RuleStore } = {}): Promise<Built> {
  const store = Array.isArray(rules) ? new ConfigRuleStore((rules as readonly Omit<RuleDef, 'source'>[]).map(rule)) : (rules as RuleStore);
  const base = { roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore(rows), rules: opts.db ? [store, opts.db] : store };
  const model = new RbacModel({ ...base, extensions: [...createRbacExtensions(base), rbacAssignmentExtension(base, { rules: opts.lists !== false })], log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  model.grantIndex();
  const natives = model.extensions.flatMap((e) => e.nativeFilters?.() ?? []) as NativeFilter[];
  return { model, ctx: (now = NOW) => fakeEvaluationContext({ now, scopeResolvers: [scopes], conditions: new DefaultConditionCompiler(undefined, [scopes]), nativeFilters: natives }) };
}

const vote = (b: Built, permission: string, resource: ResourceRef, principal: Principal = userPrincipal('alice'), c = b.ctx(), env?: Record<string, unknown>): Promise<Vote> => Promise.resolve(b.model.evaluate({ principal, permission, resource, ...(env ? { env } : {}) }, c));
const allows = (f: ResourceFilter, row: (typeof FILES)[number], principal: Principal, c: EvaluationContext) => evaluateFilter(f, { id: row.ref.id, name: row.name }, { principal, ref: row.ref, context: c }).then((t) => t === true);
const decided = (v: Vote): ResourceFilter => ({ op: 'and', args: [v.permitWhen, { op: 'not', arg: v.denyWhen }] });

/** Every file row: the type-level filter selects it exactly when the check on it allows. */
async function agrees(b: Built, permission: string, principal: Principal = userPrincipal('alice'), at: { readonly now?: Date; readonly env?: Record<string, unknown> } = {}): Promise<string[]> {
  const c = b.ctx(at.now);
  const list = decided(await vote(b, permission, FILE, principal, c, at.env));
  const out: string[] = [];
  for (const row of FILES) {
    // A check that fails (model_error) denies.
    const checked = await vote(b, permission, row.ref, principal, c, at.env).then(
      (v) => allows(decided(v), row, principal, c),
      () => false,
    );
    const listed = await allows(list, row, principal, c);
    if (listed !== checked) out.push(`${permission} ${row.ref.id}: listed ${listed}, checked ${checked}`);
  }
  return out;
}

const terms = (f: ResourceFilter, op: string): unknown[] => {
  if (f.op === op) return [(f as { args: unknown }).args];
  if (f.op === 'and' || f.op === 'or') return f.args.flatMap((a) => terms(a, op));
  if (f.op === 'not') return terms(f.arg, op);
  return [];
};

describe('authz-rbac lists under rules (args v2, native:rbac.threshold)', () => {
  describe('the args', () => {
    it('v2 holds the context and the route, canonical; the parser reads it back and refuses anything else', async () => {
      const b = await build([assignment('a1', 'editor', P1), assignment('a2', 'viewer', GLOBAL, { tags: ['inspect'] })], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }]);
      const v = await vote(b, 'file:edit', FILE);
      const [args] = terms(v.permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect(args).to.deep.equal({
        companions: [],
        config: [],
        dbRules: false,
        permission: 'file:edit',
        principal: { id: 'alice', type: 'user' },
        route: { grant: 0, ladder: 'project', role: 'editor', roles: ['editor', 'maintainer', 'org.admin', 'support', 'team.lead'] },
        rules: [{ id: 'c', kind: 'cap', ladder: 'project', maxRole: 'viewer', scope: { id: 'o1', type: 'org' } }],
        subjects: [{ id: 'alice', type: 'user' }],
        v: 2,
      });
      expect(JSON.stringify(args)).to.equal(JSON.stringify(parseRbacListArgs(RBAC_ASSIGNMENT_OP, JSON.parse(JSON.stringify(args)))));
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, extra: 1 })).to.throw('unknown args key');
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, v: 3 })).to.throw('unsupported args version');
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, subjects: [...args.subjects, ...args.subjects] })).to.throw('canonical');
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, rules: [{ ...args.rules[0], when: undefined, colour: 1 }] })).to.throw('unknown rule key');
    });

    it('v1 stays as it was where nothing depends on rules', async () => {
      const b = await build([assignment('a1', 'viewer', P1)], []);
      expect((await vote(b, 'file:read', FILE)).permitWhen).to.deep.equal({ op: RBAC_ASSIGNMENT_OP, args: { v: 1, subjects: [{ type: 'user', id: 'alice' }], roles: ['viewer'] } });
    });

    it('binds the request: selectors decided, principal and env values constant, mixed leaves made literal; an env read is uncacheable', async () => {
      const rules: Omit<RuleDef, 'source'>[] = [
        { id: 'a-svc', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { principalTypes: ['service'] } },
        {
          id: 'b-attr',
          kind: 'cap',
          scope: GLOBAL,
          ladder: 'project',
          maxRole: 'viewer',
          when: {
            any: [
              { attr: 'principal.attributes.x', eq: true },
              { attr: 'scope.org.policies.locked', eq: true },
            ],
          },
        },
        { id: 'c-mixed', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', resource: { attr: 'resource.name', eq: { ref: 'principal.attributes.file' } } },
        { id: 'd-env', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', when: { attr: 'env.mode', eq: 'strict' } },
      ];
      const b = await build([assignment('a1', 'editor', P1)], rules);
      const alice = userPrincipal('alice', { attributes: { x: false, file: 'notes' } });
      const v = await Promise.resolve(b.model.evaluate({ principal: alice, permission: 'file:edit', resource: FILE, env: { mode: 'strict' } }, b.ctx()));
      const [args] = terms(v.permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect(args.rules).to.deep.equal([
        { id: 'b-attr', kind: 'cap', ladder: 'project', maxRole: 'viewer', scope: { type: '$global' }, when: { any: [{ const: false }, { attr: 'scope.org.policies.locked', eq: true }] } },
        { id: 'c-mixed', kind: 'threshold', minRole: 'maintainer', resource: { attr: 'resource.name', eq: 'notes' }, scope: { type: '$global' } },
        { id: 'd-env', kind: 'threshold', minRole: 'maintainer', scope: { type: '$global' } },
      ]);
      expect(v.cacheable).to.equal(false);
      const thresholds = (v.denies ?? []).map((d) => [(d.when as { args: RbacThresholdArgs }).args.threshold, d.reason]);
      expect(thresholds).to.deep.equal([
        [{ rule: 'c-mixed' }, { code: 'threshold', rule: 'c-mixed', priority: 600 }],
        [{ rule: 'd-env' }, { code: 'threshold', rule: 'd-env', priority: 600 }],
      ]);
    });
  });

  describe('check ⇔ filter', () => {
    const cases: [string, Assignment[], Omit<RuleDef, 'source'>[]][] = [
      ['a cap on one org', [assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }]],
      ['a restrict at a project', [assignment('a1', 'editor', O1), assignment('a2', 'viewer', FILES[1].ref)], [{ id: 'r', kind: 'restrict', scope: P1, allow: [] }]],
      ['a cap with an attribute condition', [assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.org.policies.locked', eq: true } }]],
      ['a threshold with a wildcard resource pattern', [assignment('a1', 'editor')], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', resource: { attr: 'resource.name', wildcard: 'release/*' } }]],
      ['a threshold on the org ladder at the org', [assignment('a1', 'editor'), assignment('a2', 'org.member', O1)], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: 'org.member' }]],
      ['a strip-tags cap', [assignment('a1', 'viewer', GLOBAL, { tags: ['inspect'] })], [{ id: 's', kind: 'cap', scope: O2, stripTags: true }]],
      [
        'implied roles under a cap and a restrict',
        [assignment('a1', 'org.admin', O1), assignment('a2', 'team.lead', O2)],
        [
          { id: 'c', kind: 'cap', scope: P2, ladder: 'project', maxRole: 'viewer' },
          { id: 'r', kind: 'restrict', scope: FILES[0].ref, allow: [] },
        ],
      ],
    ];
    for (const [name, rows, rules] of cases) {
      it(name, async () => {
        const b = await build(rows, rules);
        for (const p of ['file:read', 'file:edit', 'file:admin', 'inspect:view', 'repo:read']) expect(await agrees(b, p), p).to.deep.equal([]);
      });
    }

    it('subject sets: an assignment to a set the principal joined', async () => {
      const set: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };
      const b = await build([assignment('m1', 'org.member', O1), { id: 's1', subject: set, role: 'editor', scope: P1, source: 'test' }], [{ id: 'c', kind: 'cap', scope: FILES[1].ref, ladder: 'project', maxRole: 'viewer' }]);
      expect(await agrees(b, 'file:edit')).to.deep.equal([]);
      const v = await vote(b, 'file:edit', FILE);
      expect((terms(v.permitWhen, RBAC_ASSIGNMENT_OP)[0] as RbacAssignmentArgsV2).subjects).to.deep.include(set);
    });

    it('a rule store that is not in memory: dbRules, read per row', async () => {
      const inner = new ConfigRuleStore([rule({ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }), rule({ id: 't', kind: 'threshold', scope: P3, permissions: ['file:read'], minRole: 'editor' })]);
      const remote: RuleStore = { name: 'remote', forPath: (path, at) => inner.forPath(path, at), version: () => inner.version() };
      const b = await build([assignment('a1', 'editor')], remote);
      const v = await vote(b, 'file:edit', FILE);
      expect((terms(v.permitWhen, RBAC_ASSIGNMENT_OP)[0] as RbacAssignmentArgsV2).dbRules).to.equal(true);
      expect((v.denies ?? []).map((d) => d.reason)).to.deep.equal([{ code: 'threshold', priority: 600 }]);
      for (const p of ['file:read', 'file:edit']) expect(await agrees(b, p), p).to.deep.equal([]);
    });

    it('randomized worlds: rules of every kind, implies with bypass, sets, tags, ceilings, companions, expiry, env and function leaves, unbindable refs, DB rules', async function () {
      this.timeout(300_000);
      let seed = 0;
      const rnd = (n: number) => {
        // Math.imul keeps the product exact; the low bits of this generator repeat with a short period.
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        return (seed >>> 16) % n;
      };
      const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];
      const RULES: Omit<RuleDef, 'source'>[] = [
        { id: 'r-p1', kind: 'restrict', scope: P1, allow: [] },
        { id: 'r-owner', kind: 'restrict', scope: P2, allow: [], when: { attr: 'principal.id', eq: { ref: 'scope.org.owner' } } },
        { id: 'c-global', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer' },
        { id: 'c-o1-drop', kind: 'cap', scope: O1, ladder: 'project', maxRole: null, subjects: { rank: { ladder: 'org', at: 'org', lt: 'org.member' } } },
        { id: 'c-p2-strip', kind: 'cap', scope: P2, stripTags: true },
        { id: 'c-locked', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'editor', when: { attr: 'scope.org.policies.locked', eq: true } },
        { id: 'c-env', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer', when: { attr: 'env.mode', eq: 'strict' } },
        { id: 'c-maxref', kind: 'cap', scope: O2, ladder: 'project', maxRole: { ref: 'principal.attributes.max' } },
        { id: 't-o2', kind: 'threshold', scope: O2, permissions: ['file:edit'], minRole: 'maintainer' },
        { id: 't-release', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit', 'file:read'], minRole: 'maintainer', resource: { attr: 'resource.name', wildcard: 'release/*' } },
        { id: 't-members', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: 'org.member', when: { attr: 'principal.attributes.x', eq: true } },
        { id: 'c-level', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'principal.attributes.lvl', lt: { ref: 'scope.org.level' } } },
        { id: 'c-plain', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.org.level', gt: { ref: 'principal.attributes.lvl' } } },
        { id: 'c-fn', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { fn: 'glob', args: { value: { ref: 'scope.org.owner' }, pattern: { ref: 'principal.attributes.pat' } } } },
        {
          id: 'c-all',
          kind: 'cap',
          scope: GLOBAL,
          ladder: 'project',
          maxRole: 'viewer',
          when: {
            all: [
              { attr: 'principal.attributes.x', eq: true },
              { attr: 'scope.org.depth', gt: 0 },
            ],
          },
        },
        {
          id: 'c-any-who',
          kind: 'cap',
          scope: GLOBAL,
          ladder: 'project',
          maxRole: 'viewer',
          subjects: {
            when: {
              any: [
                { attr: 'principal.attributes.x', eq: true },
                { attr: 'scope.org.depth', gt: 0 },
              ],
            },
          },
        },
        {
          id: 't-all',
          kind: 'threshold',
          scope: GLOBAL,
          permissions: ['file:read'],
          minRole: 'editor',
          when: {
            all: [
              { attr: 'principal.attributes.x', eq: true },
              { attr: 'scope.org.depth', gt: 0 },
            ],
          },
        },
        { id: 'c-false-ref', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.max' }, when: { not: { attr: 'principal.attributes.x', eq: true } } },
        { id: 't-object', kind: 'threshold', scope: GLOBAL, permissions: ['file:read', 'file:edit'], minRole: 'maintainer', resource: { attr: 'principal.attributes.lvl', lt: { ref: 'scope.org.shape' } } },
        { id: 't-hours', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'editor', when: { fn: 'time.between', args: { from: '11:00', to: '13:00' } } },
      ];
      const SCOPES = [GLOBAL, O1, O2, P1, P2, P3, P4, ...FILES.map((f) => f.ref)];
      const NAMES = ['viewer', 'editor', 'maintainer', 'org.guest', 'org.member', 'org.admin', 'team.lead', 'support'];
      const problems: string[] = [];
      // Config worlds where a leaf's request side is missing but its scope read stays (R1(c)).
      let unboundScopeReads = 0;
      // Config worlds per rule of the composite and object shapes (R1(d), R1(e)).
      const shapes = new Map<string, number>();
      for (let w = 0; w < 150; w++) {
        if (w % 30 === 0) seed = [4242, 1, 2, 3, 4][w / 30];
        const rows: Assignment[] = [];
        for (let i = 0, n = 1 + rnd(4); i < n; i++) {
          const expiry = pick([undefined, undefined, new Date(NOW.getTime() - 1), new Date(NOW.getTime() + HOUR)]);
          rows.push(assignment(`a${i}`, pick(NAMES), pick(SCOPES), { ...(rnd(3) === 0 ? { tags: ['inspect'] } : {}), ...(expiry ? { expiresAt: expiry } : {}) }));
        }
        if (rnd(3) === 0) rows.push({ id: 'set', subject: { set: { role: 'org.member', scope: O1 } }, role: pick(['viewer', 'editor']), scope: pick([P1, P2]), source: 'test' });
        if (rnd(3) === 0) rows.push({ id: 'bob', subject: { type: 'user', id: 'bob' }, role: pick(NAMES), scope: pick(SCOPES), source: 'test' });
        const rules = RULES.filter(() => rnd(3) === 0);
        // A store that is not in memory: the rules are DB rules, read per row; a list may then be narrower, never wider.
        // 0: every rule in a store that is not in memory; 1: the rules split between both stores; else config only.
        const mode = rnd(4);
        const db = mode <= 1;
        const stored = mode === 0 ? rules : mode === 1 ? rules.filter((_, i) => i % 2 === 1) : [];
        const b = await build(rows, mode === 0 ? [] : mode === 1 ? rules.filter((_, i) => i % 2 === 0) : rules, stored.length > 0 ? { db: remote(stored) } : {});
        const attributes = { ...(rnd(2) ? { x: true } : {}), ...(rnd(2) ? { max: 'editor' } : {}), ...pick([{}, { lvl: 2 }, { lvl: '2' }]), ...(rnd(2) ? { pat: 'a*' } : {}) };
        if (!db) for (const x of rules) if (['c-all', 'c-any-who', 't-all', 'c-false-ref', 't-object'].includes(x.id)) shapes.set(x.id, (shapes.get(x.id) ?? 0) + 1);
        if (!db && rules.some((x) => (x.id === 'c-fn' && !('pat' in attributes)) || ((x.id === 'c-level' || x.id === 'c-plain') && !('lvl' in attributes)))) unboundScopeReads++;
        let principal = userPrincipal('alice', { attributes, ...(rnd(3) === 0 ? { companions: [userPrincipal('bob')] } : {}) });
        if (rnd(4) === 0) principal = { ...principal, ceiling: { roles: NAMES.filter(() => rnd(2) === 0) } } as Principal;
        for (const at of [{ now: new Date(NOW.getTime() + 3 * HOUR), env: { mode: 'strict' } }, {}]) {
          for (const p of ['file:read', 'file:edit', 'file:admin', 'inspect:view', 'repo:read']) {
            const found = (await agrees(b, p, principal, at)).filter((m) => !db || m.includes('listed true'));
            problems.push(...found.map((m) => `${JSON.stringify([rows.map((a) => [a.role, a.scope.id ?? a.scope.type]), rules.map((x) => x.id), db, attributes])} ${m}`));
          }
        }
      }
      expect(problems.slice(0, 5)).to.deep.equal([]);
      expect(unboundScopeReads).to.be.greaterThan(10);
      for (const id of ['c-all', 'c-any-who', 't-all', 'c-false-ref', 't-object']) expect(shapes.get(id) ?? 0, id).to.be.greaterThan(10);
    });
  });

  describe('binding the request into the list terms', () => {
    const editorAtP1 = [assignment('a1', 'editor', P1)];
    const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00.000Z`);

    it('a time.between leaf binds per request: uncacheable, never memoised, exact at each time', async () => {
      const b = await build(editorAtP1, [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', when: { fn: 'time.between', args: { from: '11:00', to: '13:00' } } }]);
      const late = await vote(b, 'file:edit', FILE, userPrincipal('alice'), b.ctx(at('15:00')));
      expect(late.cacheable).to.equal(false);
      expect(await agrees(b, 'file:edit', userPrincipal('alice'), { now: at('15:00') })).to.deep.equal([]);
      expect(await agrees(b, 'file:edit', userPrincipal('alice'), { now: at('12:00') })).to.deep.equal([]);
      const noon = await vote(b, 'file:edit', FILE, userPrincipal('alice'), b.ctx(at('12:00')));
      expect(noon.cacheable).to.equal(false);
      expect(terms(noon.denyWhen, RBAC_THRESHOLD_OP)).to.have.length(1);
    });

    it('an ip.in leaf reading env.ip binds per request', async () => {
      const b = await build(editorAtP1, [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', when: { not: { fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } } } }]);
      expect(await agrees(b, 'file:edit', userPrincipal('alice'), { env: { ip: '10.1.2.3' } })).to.deep.equal([]);
      expect(await agrees(b, 'file:edit', userPrincipal('alice'), { env: { ip: '8.8.8.8' } })).to.deep.equal([]);
      const v = await vote(b, 'file:edit', FILE, userPrincipal('alice'), b.ctx(), { ip: '8.8.8.8' });
      expect(v.cacheable).to.equal(false);
    });

    it('principal.id compared with a scope ref is bound with the operands swapped; checks are not affected', async () => {
      const rules: Omit<RuleDef, 'source'>[] = [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer', when: { attr: 'principal.id', eq: { ref: 'scope.org.owner' } } }];
      const b = await build([assignment('a1', 'editor')], rules);
      expect((await vote(b, 'file:edit', FILES[0].ref)).permitWhen.op).to.equal('true');
      const [args] = terms((await vote(b, 'file:edit', FILE)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      const read = { attr: 'scope.org.owner', eq: { ref: 'scope.org.owner' } };
      expect(args.rules[0].when).to.deep.equal({ all: [{ attr: 'scope.org.owner', eq: 'alice' }, { any: [read, { not: read }] }] });
      for (const who of ['alice', 'bob']) expect(await agrees(b, 'file:edit', userPrincipal(who)), who).to.deep.equal([]);
    });

    it('a ref the principal lacks makes the rule indeterminate: rows on its path are refused, the rest answer; checks are not affected', async () => {
      const b = await build([assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: { ref: 'principal.attributes.max' } }]);
      expect((await vote(b, 'file:edit', FILES[0].ref)).permitWhen.op).to.equal('true');
      const [args] = terms((await vote(b, 'file:edit', FILE)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect(args.rules).to.deep.equal([{ id: 'c', indeterminate: true, kind: 'cap', scope: { id: 'o2', type: 'org' } }]);
      expect(await agrees(b, 'file:edit')).to.deep.equal([]);
      const summary = await b.model.summarize(userPrincipal('alice'), GLOBAL, b.ctx());
      expect(summary.permissions.find((p) => p.name === 'file:edit')).to.deep.equal({ name: 'file:edit', conditional: true });
    });

    it('a rule whose condition is a definite false does not read its maxRole or minRole ref', async () => {
      const notX = { attr: 'principal.attributes.x', eq: true };
      const b = await build(editorAtP1, [
        { id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: { ref: 'principal.attributes.max' }, when: notX },
        { id: 't', kind: 'threshold', scope: O1, permissions: ['file:edit'], minRole: { ref: 'principal.attributes.min' }, when: notX },
      ]);
      const off = userPrincipal('alice', { attributes: { x: false } });
      const [offArgs] = terms((await vote(b, 'file:edit', FILE, off)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect(offArgs.rules ?? []).to.deep.equal([]);
      expect(await agrees(b, 'file:edit', off)).to.deep.equal([]);
      const on = userPrincipal('alice', { attributes: { x: true } });
      const [onArgs] = terms((await vote(b, 'file:edit', FILE, on)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect(onArgs.rules.map((x) => [x.id, x.indeterminate])).to.deep.equal([
        ['c', true],
        ['t', true],
      ]);
      expect(await agrees(b, 'file:edit', on)).to.deep.equal([]);
    });

    it('B22: an indeterminate binding is kept per principal, so a list after preload answers synchronously', async () => {
      const b = await build(editorAtP1, [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: { ref: 'principal.attributes.max' } }]);
      const c = b.ctx();
      const alice = userPrincipal('alice');
      await b.model.preload(alice, c);
      const v = b.model.evaluate({ principal: alice, permission: 'file:edit', resource: FILE }, c);
      expect(v).to.not.be.instanceOf(Promise);
      expect((terms((v as Vote).permitWhen, RBAC_ASSIGNMENT_OP)[0] as RbacAssignmentArgsV2).rules).to.deep.equal([{ id: 'c', indeterminate: true, kind: 'cap', scope: { id: 'o2', type: 'org' } }]);
    });

    it('a leaf whose request side is missing still reads its scope path: f5, in no org, is not listed where its check fails', async () => {
      const when = [
        { attr: 'principal.attributes.lvl', lt: { ref: 'scope.org.level' } },
        { attr: 'scope.org.level', gt: { ref: 'principal.attributes.lvl' } },
        { fn: 'glob', args: { value: { ref: 'scope.org.owner' }, pattern: { ref: 'principal.attributes.pat' } } },
      ];
      for (const w of when) {
        const b = await build([assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: w }]);
        let thrown: unknown;
        try {
          await vote(b, 'file:read', FILES[4].ref);
        } catch (e) {
          thrown = e;
        }
        expect((thrown as Error | undefined)?.message, JSON.stringify(w)).to.contain('indeterminate');
        for (const p of ['file:read', 'file:edit']) expect(await agrees(b, p), `${p} ${JSON.stringify(w)}`).to.deep.equal([]);
        for (const p of ['file:read', 'file:edit']) expect(await agrees(b, p, userPrincipal('alice', { attributes: { lvl: 2, pat: 'b*' } })), `${p} ${JSON.stringify(w)}`).to.deep.equal([]);
      }
    });

    describe('the binder keeps every scope read the check makes', () => {
      const x = (v: boolean | Record<string, unknown>) => userPrincipal('alice', { attributes: typeof v === 'boolean' ? { x: v, lvl: '2' } : v });
      const cases: [string, Omit<RuleDef, 'source'>, boolean | Record<string, unknown>][] = [
        [
          'all with a FALSE principal child (cap)',
          {
            id: 'c',
            kind: 'cap',
            scope: GLOBAL,
            ladder: 'project',
            maxRole: 'viewer',
            when: {
              all: [
                { attr: 'principal.attributes.x', eq: true },
                { attr: 'scope.org.depth', gt: 0 },
              ],
            },
          },
          false,
        ],
        [
          'all with a FALSE principal child (threshold)',
          {
            id: 't',
            kind: 'threshold',
            scope: GLOBAL,
            permissions: ['file:read'],
            minRole: 'maintainer',
            when: {
              all: [
                { attr: 'principal.attributes.x', eq: true },
                { attr: 'scope.org.depth', gt: 0 },
              ],
            },
          },
          false,
        ],
        [
          'any with a TRUE principal child',
          {
            id: 'c',
            kind: 'cap',
            scope: GLOBAL,
            ladder: 'project',
            maxRole: 'viewer',
            when: {
              any: [
                { attr: 'principal.attributes.x', eq: true },
                { attr: 'scope.org.depth', gt: 0 },
              ],
            },
          },
          true,
        ],
        [
          'any with a TRUE principal child in subjects.when',
          {
            id: 'c',
            kind: 'cap',
            scope: GLOBAL,
            ladder: 'project',
            maxRole: 'viewer',
            subjects: {
              when: {
                any: [
                  { attr: 'principal.attributes.x', eq: true },
                  { attr: 'scope.org.depth', gt: 0 },
                ],
              },
            },
          },
          true,
        ],
        ['a FALSE when beside a scope ref maxRole', { id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.max' }, when: { attr: 'principal.attributes.x', eq: true } }, false],
        ['a swapped leaf over an object attribute', { id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:read'], minRole: 'maintainer', resource: { attr: 'principal.attributes.lvl', lt: { ref: 'scope.org.shape' } } }, true],
        ['a swapped eq leaf over an object attribute', { id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'principal.attributes.lvl', eq: { ref: 'scope.org.shape' } } }, { lvl: true }],
      ];
      for (const [name, def, on] of cases) {
        it(name, async () => {
          const b = await build([assignment('a1', 'editor')], [def]);
          const failing: string[] = [];
          for (const row of FILES)
            if (
              await vote(b, 'file:read', row.ref, x(on)).then(
                () => false,
                () => true,
              )
            )
              failing.push(row.ref.id!);
          expect(failing.length, 'some check faults').to.be.greaterThan(0);
          for (const p of ['file:read', 'file:edit']) expect(await agrees(b, p, x(on)), p).to.deep.equal([]);
        });
      }
    });

    it('a stored rule over resource.* that no vote can follow: the check fails closed, the list refuses the rows', async () => {
      const x = { attr: 'principal.attributes.x', eq: true };
      const defs = [rule({ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.max' }, when: x, subjects: { when: { any: [x, { attr: 'resource.name', wildcard: 'release/*' }] } } })];
      // Not a ConfigRuleStore, which refuses the rule when it reads it.
      const b = await build([assignment('a1', 'editor')], { name: 'remote', forPath: async () => defs, version: async () => '1' });
      const alice = userPrincipal('alice', { attributes: { x: false } });
      let thrown: unknown;
      try {
        await vote(b, 'file:read', FILES[0].ref, alice);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).to.contain('subjects.when reads resource.*');
      const c = b.ctx();
      const list = decided(await vote(b, 'file:read', FILE, alice, c));
      for (const row of FILES) expect(await allows(list, row, alice, c), row.ref.id).to.equal(false);
    });

    describe('a stored rule that reads request facts refuses every row on its path', () => {
      const neverWider = (found: string[]) => found.filter((m) => m.includes('listed true'));
      const listed = async (b: Built, permission: string, principal: Principal) => {
        const c = b.ctx();
        const list = decided(await vote(b, permission, FILE, principal, c));
        const out: string[] = [];
        for (const row of FILES) if (await allows(list, row, principal, c)) out.push(row.ref.id!);
        return out;
      };

      it('a null test on a principal attribute: no row under the rule is listed', async () => {
        const b = await build([assignment('a1', 'editor')], remote([{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { not: { attr: 'principal.attributes.vip', null: true } } }]));
        const vip = userPrincipal('alice', { attributes: { vip: true } });
        expect(await agrees(b, 'file:edit', vip)).to.deep.equal([]);
        expect(neverWider(await agrees(b, 'file:edit'))).to.deep.equal([]);
        expect(await listed(b, 'file:read', vip)).to.deep.equal([]);
      });

      it('a restrict on principal.authenticated refuses the rows under it; the others answer', async () => {
        const anonymous = { ...userPrincipal('anon'), type: 'anonymous', authenticated: false } as Principal;
        const b = await build([assignment('a1', 'editor', GLOBAL, { subject: { type: 'anonymous', id: 'anon' } })], remote([{ id: 'r', kind: 'restrict', scope: P1, allow: [], when: { attr: 'principal.authenticated', eq: false } }]));
        expect(await agrees(b, 'file:edit', anonymous)).to.deep.equal([]);
        expect(await listed(b, 'file:edit', anonymous)).to.deep.equal(['f3', 'f4', 'f5']);
      });

      it('principal.lvl lt scope.org.level refuses the rows under it, a row in no org included', async () => {
        const rules: Omit<RuleDef, 'source'>[] = [{ id: 'c', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'principal.attributes.lvl', lt: { ref: 'scope.org.level' } } }];
        const alice = userPrincipal('alice', { attributes: { lvl: 2 } });
        const stored = await build([assignment('a1', 'editor')], remote(rules));
        let thrown: unknown;
        try {
          await vote(stored, 'file:read', FILES[4].ref, alice);
        } catch (e) {
          thrown = e;
        }
        expect((thrown as Error).message).to.contain('indeterminate');
        expect(await listed(stored, 'file:read', alice)).to.deep.equal([]);
        for (const p of ['file:read', 'file:edit']) expect(neverWider(await agrees(stored, p, alice)), p).to.deep.equal([]);
        const config = await build([assignment('a1', 'editor')], rules);
        for (const p of ['file:read', 'file:edit']) expect(await agrees(config, p, alice), p).to.deep.equal([]);
        expect(await listed(config, 'file:edit', alice)).to.deep.equal(['f4']);
      });
    });

    it('the evaluator requires the route fields: a holder outside route.roles does not pass', async () => {
      const b = await build([assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer' }]);
      const c = b.ctx();
      const v = await vote(b, 'file:edit', FILE, userPrincipal('alice'), c);
      const [args] = terms(v.permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      const filter = b.model.extensions.flatMap((e) => e.nativeFilters?.() ?? []).find((f) => f.op === RBAC_ASSIGNMENT_OP)!;
      const row = FILES[0];
      expect(await filter.matches(args, { id: row.ref.id, name: row.name }, row.ref, c)).to.equal(true);
      const wrong = rbacAssignmentArgsV2(args, { ...args.route, roles: ['maintainer'] });
      expect(await filter.matches(wrong, { id: row.ref.id, name: row.name }, row.ref, c)).to.equal(false);
      const noGrant = rbacAssignmentArgsV2(args, { ...args.route, grant: 5 });
      let thrown: unknown;
      try {
        await filter.matches(noGrant, {}, row.ref, c);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).to.contain('names no grant');
    });

    it('the args parser refuses duplicate rule ids, a fractional grant and an indeterminate flag other than true', async () => {
      const b = await build(editorAtP1, [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer' }]);
      const [args] = terms((await vote(b, 'file:edit', FILE)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, rules: [args.rules[0], args.rules[0]] })).to.throw('share an id');
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, route: { ...args.route, grant: 0.5 } })).to.throw('route must be');
      expect(() => parseRbacListArgs(RBAC_ASSIGNMENT_OP, { ...args, rules: [{ ...args.rules[0], indeterminate: false }] })).to.throw('indeterminate');
    });

    it('the builders refuse what the parser would: lists past MAX_LIST_ITEMS, args past MAX_LIST_ARGS_LENGTH', async () => {
      const b = await build(editorAtP1, [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer' }]);
      const [args] = terms((await vote(b, 'file:edit', FILE)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      const many = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `r${i}`);
      expect(() => rbacAssignmentArgsV2({ ...args, ceilingRoles: many }, args.route)).to.throw('ceilingRoles exceed');
      expect(() => rbacAssignmentArgsV2(args, { ...args.route, roles: many })).to.throw('route roles exceed');
      expect(() => rbacThresholdArgs({ ...args, companions: many.map((id) => ({ type: 'user', id })) }, { db: true })).to.throw('companions exceed');
      const long = 'x'.repeat(MAX_LIST_ARGS_LENGTH);
      expect(() => rbacThresholdArgs({ ...args, permission: long }, { db: true })).to.throw('characters exceed');
    });

    it('the binding memo keeps the most recently used principals; per-request bindings are never kept', async () => {
      const b = await build(editorAtP1, [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer', when: { attr: 'principal.attributes.x', eq: true } }]);
      const c = b.ctx();
      const alice = userPrincipal('alice', { attributes: { x: true } });
      await b.model.preload(alice, c);
      for (let i = 0; i < 300; i++) {
        // Each new principal pushes the oldest one out; alice is used again on every round.
        await vote(b, 'file:read', FILES[0].ref, userPrincipal(`u${i}`), c);
        if (i % 50 === 0) expect(b.model.evaluate({ principal: alice, permission: 'file:edit', resource: FILE }, c)).to.not.be.instanceOf(Promise);
      }
      expect(b.model.evaluate({ principal: alice, permission: 'file:edit', resource: FILE }, c)).to.not.be.instanceOf(Promise);
      const timed = await build(editorAtP1, [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', when: { fn: 'time.between', args: { from: '11:00', to: '13:00' } } }]);
      const tc = timed.ctx();
      await timed.model.preload(alice, tc);
      expect(timed.model.evaluate({ principal: alice, permission: 'file:edit', resource: FILE }, tc)).to.be.instanceOf(Promise);
    });

    it('rules: true without a rule store lists tags and provenance with args v2', async () => {
      const base = { roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore([assignment('a1', 'viewer'), assignment('a2', 'org.member', P1, { tags: ['inspect'] })]) };
      const model = new RbacModel({ ...base, extensions: [...createRbacExtensions(base), rbacAssignmentExtension(base, { rules: true })], log: { warn: () => undefined } });
      await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      const v = await Promise.resolve(model.evaluate({ principal: userPrincipal('alice'), permission: 'inspect:view', resource: FILE }, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] })));
      expect(terms(v.permitWhen, RBAC_ASSIGNMENT_OP)).to.have.length(1);
    });
  });

  describe('two rule stores (design §8.5: ConfigRuleStore and DbRuleStore)', () => {
    it('a config cap and a DB restrict apply together, on checks and on lists', async () => {
      const b = await build([assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: O2, ladder: 'project', maxRole: 'viewer' }], { db: remote([{ id: 'r', kind: 'restrict', scope: P1, allow: [] }]) });
      const [args] = terms((await vote(b, 'file:read', FILE)).permitWhen, RBAC_ASSIGNMENT_OP) as RbacAssignmentArgsV2[];
      expect([args.rules.map((x) => x.id), args.dbRules]).to.deep.equal([['c'], true]);
      const op = async (p: string, i: number) => (await vote(b, p, FILES[i].ref)).permitWhen.op;
      // f1 under the DB restrict at p1, f3 free, f4 under the config cap at o2.
      expect([await op('file:read', 0), await op('file:edit', 2), await op('file:edit', 3), await op('file:read', 3)]).to.deep.equal(['false', 'true', 'false', 'true']);
      for (const p of ['file:read', 'file:edit']) expect(await agrees(b, p), p).to.deep.equal([]);
    });

    it('reads each path of the DB part once per request: checks and summarize share the read', async () => {
      let reads = 0;
      const inner = remote([{ id: 'r', kind: 'restrict', scope: P2, allow: [] }]);
      const counting: RuleStore = {
        name: 'remote',
        forPath: (path, at) => {
          reads++;
          return inner.forPath(path, at);
        },
        version: () => inner.version(),
      };
      const b = await build([assignment('a1', 'editor')], [], { db: counting });
      const c = b.ctx();
      for (const p of ['file:read', 'file:edit', 'file:admin']) await vote(b, p, FILES[0].ref, userPrincipal('alice'), c);
      await b.model.summarize(userPrincipal('alice'), FILES[0].ref, c);
      expect(reads).to.equal(1);
      await vote(b, 'file:read', FILES[0].ref);
      expect(reads, 'another request reads again').to.equal(2);
    });

    it('two DB rule stores with one name do not share a request read', async () => {
      const restricted = await build([assignment('a1', 'editor')], [], { db: remote([{ id: 'r', kind: 'restrict', scope: P1, allow: [] }]) });
      const open = await build([assignment('a1', 'editor')], [], { db: remote([]) });
      const c = restricted.ctx();
      expect((await vote(restricted, 'file:read', FILES[0].ref, userPrincipal('alice'), c)).permitWhen.op).to.equal('false');
      expect((await vote(open, 'file:read', FILES[0].ref, userPrincipal('alice'), c)).permitWhen.op).to.equal('true');
      expect((await vote(restricted, 'file:read', FILES[0].ref, userPrincipal('alice'), c)).permitWhen.op).to.equal('false');
    });

    it('two stores of one sort are refused', () => {
      const config = () => new ConfigRuleStore([]);
      expect(() => ruleStoreParts([config(), config()])).to.throw(AuthzConfigError, 'one in memory and one other at most');
      expect(() => ruleStoreParts([remote([]), remote([])])).to.throw(AuthzConfigError, 'one in memory and one other at most');
      const parts = ruleStoreParts([remote([]), config()]);
      expect([parts.config?.name, parts.db?.name]).to.deep.equal(['ConfigRuleStore', 'remote']);
    });
  });

  describe('fail closed and the rest of the model', () => {
    it('without rules: true a list that rules would treat per row still throws RuleRowsError', async () => {
      const b = await build([assignment('a1', 'editor')], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }], { lists: false });
      let thrown: unknown;
      try {
        await vote(b, 'file:edit', FILE);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(RuleRowsError);
    });

    it('B22: after preload a list with config rules (conditions included) answers synchronously', async () => {
      const b = await build([assignment('a1', 'editor', P1)], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer', when: { attr: 'principal.attributes.x', eq: true } }]);
      const c = b.ctx();
      const alice = userPrincipal('alice', { attributes: { x: true } });
      await b.model.preload(alice, c);
      const v = b.model.evaluate({ principal: alice, permission: 'file:edit', resource: FILE }, c);
      expect(v).to.not.be.instanceOf(Promise);
      expect(terms((v as Vote).permitWhen, RBAC_ASSIGNMENT_OP)).to.have.length(1);
    });

    it('summarize lists what some row may pass as conditional and leaves out what no grant reaches', async () => {
      const b = await build([assignment('a1', 'viewer', P1)], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }]);
      const summary = await b.model.summarize(userPrincipal('alice'), GLOBAL, b.ctx());
      expect(summary.permissions.map((p) => [p.name, p.conditional])).to.deep.equal([
        ['file:read', true],
        ['inspect:view', true],
        ['repo:read', true],
      ]);
    });

    it('summarize lists the union of the fields of every grant some row passes, with the list terms', async () => {
      const base = {
        roles: new MemoryRoleStore([role('readsA', [{ permission: 'doc:read', fields: { read: ['a'] } }]), role('readsB', [{ permission: 'doc:read', fields: { read: ['b'] } }])], []),
        assignments: new MemoryAssignmentStore([assignment('a1', 'readsA', P1), assignment('a2', 'readsB', P2)]),
        rules: new ConfigRuleStore([rule({ id: 'r', kind: 'restrict', scope: O2, allow: [] })]),
      };
      const model = new RbacModel({ ...base, extensions: [...createRbacExtensions(base), rbacAssignmentExtension(base, { rules: true })], log: { warn: () => undefined } });
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'doc:read', types: ['doc'], fields: true }], 'test');
      reg.freeze();
      await model.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
      const summary = await model.summarize(userPrincipal('alice'), GLOBAL, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] }));
      expect(summary.permissions).to.deep.equal([{ name: 'doc:read', conditional: true, fields: { read: ['a', 'b'], write: ['*'] } }]);
    });

    it('the vote is bounded by the expiry of the holders and of the rules', async () => {
      const b = await build([assignment('a1', 'editor', P1, { expiresAt: new Date(NOW.getTime() + 2 * HOUR) })], [{ id: 'c', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer', expiresAt: new Date(NOW.getTime() + HOUR) }]);
      expect((await vote(b, 'file:edit', FILE)).validUntil).to.deep.equal(new Date(NOW.getTime() + HOUR));
    });

    it('no grant of the permission reachable: FALSE with no_access, and the threshold terms a check denies by', async () => {
      const b = await build([assignment('a1', 'viewer', P1)], [{ id: 't', kind: 'threshold', scope: GLOBAL, permissions: ['file:admin'], minRole: 'maintainer' }]);
      const v = await vote(b, 'file:admin', FILE);
      expect(v.permitWhen).to.deep.equal(FALSE);
      expect(terms(v.denyWhen, RBAC_THRESHOLD_OP)).to.have.length(1);
      // The check of a row denies by the threshold too: another model's permit must not pass it in a list.
      const row = await vote(b, 'file:admin', FILES[0].ref);
      expect([row.permitWhen.op, row.denyWhen.op]).to.deep.equal(['false', 'true']);
      const c = b.ctx();
      expect(await allows((await vote(b, 'file:admin', FILE, userPrincipal('alice'), c)).denyWhen, FILES[0], userPrincipal('alice'), c)).to.equal(true);
    });
  });
});
