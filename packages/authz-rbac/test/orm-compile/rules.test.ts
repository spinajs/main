import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { Assignment, Principal, ResourceFilter, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, parseRbacListArgs, rbacAssignmentArgsV2, rbacThresholdArgs } from '../../src/index.js';
import type { RbacAssignmentArgsV2, RbacThresholdArgs } from '../../src/index.js';
import { RbacListCompiler, RbacRoleGraphSource, RbacScopeAttributeSource, RbacSql } from '../../src/orm/index.js';
import { sqliteParserDepth } from '../../src/orm/compile/sqlite-depth.js';
import { SQLITE_ODD_DOCS } from '../orm/orm-world.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { RouteWorld, assignment, at, registerRouteSources, routeArgs, service, team, thresholdArgs, u, user } from './route-world.js';

/*
 * L4b task "rules": args v2 with bound config rules and native:rbac.threshold { rule } in SQL. For every
 * case, per row: check() (the row as subject) = the rows authz-orm lists (the middleware for doc:read,
 * compileResidual otherwise) = the in-memory list filter. Docs (ORM_DOCS): 1 p10/o1, 2 p10/o2, 3 p11/o1,
 * 4 -/o2, 5 p12/-, 6 p13/'', 7 p10/'O1', 8 p11/'o10'; org rows o1 and o2 only.
 */

type Rule = Omit<RuleDef, 'source'>;

const ALL = ['1', '2', '3', '4', '5', '6', '7', '8'];
const P = (id: string) => at('project', id);
const O = (id: string) => at('org', id);
const D = (id: string) => at('doc', id);

const SCHEMAS: readonly ScopeAttributeSchema[] = [
  { scopeType: 'org', schema: {}, defaults: { policies: { locked: false, min_role: 'commenter' } } },
  { scopeType: 'project', schema: {}, defaults: { tier: 'basic' } },
];
const ATTRS = [
  [O('o1'), { policies: { locked: true, max_role: 'viewer', min_role: 'editor', level: 3, tag: 'a' } }],
  [O('o2'), { policies: { max_role: 'editor', level: 1, tag: 'b' } }],
  [GLOBAL, { mode: 'strict' }],
  [P('10'), { tier: 'gold' }],
] as const;

describe('authz-rbac orm-compile: restrict, cap and threshold rules in SQL', function () {
  this.timeout(600000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_rules');
    await (await testHost.domains()).service('root');
    undoSources = registerRouteSources();
  });

  after(async () => {
    undoSources?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: RouteWorld;
      const terms = { route: 0, threshold: 0 };

      before(async () => {
        world = await RouteWorld.open(db, kind);
      });

      after(async () => {
        await world?.close();
      });

      async function scenario(rules: readonly Rule[], rows: readonly Assignment[]): Promise<void> {
        await world.configure({ rules, schemas: SCHEMAS, attributes: ATTRS });
        await world.assign(rows);
      }

      /** B06 for `p`: check() per row = listed through authz-orm = the in-memory list filter (= `want` when given). */
      async function lists(p: Principal, permission: string, want?: readonly string[]): Promise<ResourceFilter> {
        const residual = await world.residual(p, permission);
        terms.route += routeArgs(residual).filter((a) => (a.rules as unknown[]).length > 0).length;
        terms.threshold += thresholdArgs(residual).length;
        const allowed = await world.allowed(p, permission);
        const why = `${kind} ${p.id} ${permission}: ${JSON.stringify(residual)}`;
        if (want) expect(allowed, `check(), ${why}`).to.deep.equal([...want].sort());
        expect(await world.listed(p, permission), `listed, ${why}`).to.deep.equal(allowed);
        expect(await world.inMemory(residual, p), `in memory, ${why}`).to.deep.equal(allowed);
        return residual;
      }

      /** Narrower than the check, as documented: `want` listed, `gap` allowed by check() only; the in-memory filter = check(). */
      async function narrower(p: Principal, permission: string, want: readonly string[], gap: readonly string[]): Promise<void> {
        const residual = await world.residual(p, permission);
        const allowed = await world.allowed(p, permission);
        expect(allowed, `${kind} check ${permission}`).to.deep.equal([...want, ...gap].sort());
        expect(await world.listed(p, permission), `${kind} listed ${permission}`).to.deep.equal([...want].sort());
        expect(await world.inMemory(residual, p), `${kind} in memory ${permission}`).to.deep.equal(allowed);
      }

      it('restrict: drops what is assigned above its node unless allowed (principal or set) or bypassed; a when on a scope attribute', async () => {
        await scenario(
          [
            { id: 'r1', kind: 'restrict', scope: P('10'), allow: [{ type: 'user', id: 'bob' }] },
            { id: 'r2', kind: 'restrict', scope: D('3'), allow: [] },
            { id: 'r3', kind: 'restrict', scope: O('o2'), allow: [{ set: { role: 'team.member', scope: at('team', 't1') } }] },
            { id: 'r4', kind: 'restrict', scope: O('o1'), allow: [{ type: 'user', id: 'cid' }], when: { attr: 'scope.org.policies.locked', eq: true } },
          ],
          [assignment(u('ann'), 'editor', GLOBAL), assignment(u('bob'), 'editor', GLOBAL), assignment(u('cid'), 'editor', P('10')), assignment(u('cid'), 'viewer', GLOBAL), assignment(u('dan'), 'support', GLOBAL), assignment(u('gus'), 'team.member', at('team', 't1')), assignment(team('t1'), 'editor', GLOBAL), assignment(u('hal'), 'editor', at('doc'))],
        );
        await lists(user('ann'), 'doc:edit', ['5', '6', '8']);
        await lists(user('bob'), 'doc:edit', ['5', '6', '7', '8']);
        await lists(user('cid'), 'doc:edit', ['1', '2', '7']);
        await lists(user('cid'), 'doc:read', ['1', '2', '5', '6', '7', '8']);
        // support implies viewer with bypass 'restrict'.
        await lists(user('dan'), 'doc:read', ALL);
        await lists(user('gus'), 'doc:edit', ['4', '5', '6', '8']);
        // The row type's type-only scope is above every node: any restrict on the path drops it.
        await lists(user('hal'), 'doc:edit', ['5', '6', '8']);
        await lists(service('s1'), 'doc:read', ALL);
        await lists(service('s2'), 'doc:edit', ['5', '6', '8']);
      });

      it('restrict: rank selectors read the ranks after collect; an UNKNOWN when applies; a rule without its node faults only where it would drop', async () => {
        await scenario(
          [
            { id: 'r1', kind: 'restrict', scope: O('o1'), subjects: { rank: { ladder: 'project', at: 'project', lt: 'editor' } }, allow: [] },
            { id: 'r2', kind: 'restrict', scope: O('o2'), when: { attr: 'principal.attributes.contractor', eq: true }, allow: [] },
            // Reads scope.project.*: doc 4 has no project, so it is indeterminate there.
            { id: 'r3', kind: 'restrict', scope: GLOBAL, when: { attr: 'scope.project.tier', eq: 'gold' }, allow: [] },
          ],
          [assignment(u('ann'), 'viewer', P('10')), assignment(u('ann'), 'viewer', GLOBAL), assignment(u('bea'), 'editor', P('11')), assignment(u('bea'), 'viewer', GLOBAL), assignment(u('cid'), 'viewer', at('doc')), assignment(u('dan'), 'maintainer', O('o2'))],
        );
        await lists(user('ann'), 'doc:read', ['1', '2', '5', '6', '7', '8']);
        await lists(user('bea'), 'doc:read', ['3', '5', '6', '7', '8']);
        // cid's type-only viewer: r3 at GLOBAL drops it where it applies, and faults at doc 4 (no project node).
        await lists(user('cid'), 'doc:read');
        await lists(user('dan'), 'doc:read', ['2', '4']);
        await lists({ ...user('dan'), attributes: { contractor: false } } as Principal, 'doc:read', ['2', '4']);
      });

      it('restrict: a when leaf SQL cannot decide refuses the rows whose outcome depends on it, never lists more (review probes A-D)', async () => {
        // FALSE in the check (o1's tag is 'a', o2's 'b'); SQL cannot match a pattern against a scope attribute.
        const pattern: NonNullable<Rule['when']> = { attr: 'scope.org.policies.tag', wildcard: 'zz*' };
        const r1 = (scope: ReturnType<typeof O>, when: Rule['when'] | null = pattern): Rule => ({ id: 'r1', kind: 'restrict', scope, allow: [], ...(when ? { when } : {}) });
        const gteEditor = { rank: { ladder: 'project', at: 'project', gte: 'editor' } };
        const annRows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', P('10'))];
        // A: a restrict dropping the GLOBAL editor would stop a rank-selected cap from clamping ann's commenter at doc 1.
        await scenario([r1(O('o1')), { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: gteEditor }], annRows);
        await lists(user('ann'), 'doc:comment', ['4']);
        // Control: a restrict that applies does keep the cap from selecting ann at doc 1.
        await scenario([r1(O('o1'), null), { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: gteEditor }], annRows);
        await lists(user('ann'), 'doc:comment', ['1', '4']);
        // B: the same through a rank-selected threshold.
        await scenario([r1(O('o1')), { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', subjects: gteEditor }], annRows);
        await lists(user('ann'), 'doc:comment', ['4']);
        const o2Rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', O('o2'))];
        // C: r2 has no project node at doc 4 and throws there, as it would drop the GLOBAL editor that r1 keeps.
        await scenario([r1(O('o2')), { id: 'r2', kind: 'restrict', scope: O('o2'), allow: [], when: { attr: 'scope.project.tier', eq: 'gold' } }], o2Rows);
        await narrower(user('ann'), 'doc:comment', ['1', '3', '5', '6', '7', '8'], ['2']);
        // D: the cap has no project node at doc 4 and throws there, as it would act on the GLOBAL editor that r1 keeps.
        await scenario([r1(O('o2')), { id: 'c1', kind: 'cap', scope: O('o2'), ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.project.tier', eq: 'gold' }, assignments: { scopeTypes: ['$global'] } }], o2Rows);
        await narrower(user('ann'), 'doc:comment', ['1', '3', '5', '6', '7', '8'], ['2']);
        // Where the rest of the when decides, the leaf does not matter.
        await scenario([r1(O('o1'), { all: [pattern, { attr: 'scope.org.policies.locked', eq: false }] }), { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: gteEditor }], annRows);
        await lists(user('ann'), 'doc:comment', ['4']);
        await lists(user('ann'), 'doc:edit', ['4']);
      });

      it('a stored string spelled with an escape is not compared by its text: UNKNOWN, so a cap applies and a restrict refuses', async () => {
        const respell = () => db.raw(kind, `UPDATE "authz_scope_attribute" SET "value_json" = '"\\u0061"' WHERE "scope_type" = 'org' AND "scope_id" = 'o1' AND "path" = 'policies.tag'`);
        await scenario([{ id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.org.policies.tag', eq: 'a' } }], [assignment(u('ann'), 'editor', GLOBAL)]);
        await respell();
        await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        await scenario([{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.org.policies.tag', in: ['b', 'a'] } }], [assignment(u('ann'), 'editor', GLOBAL)]);
        await respell();
        await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        await scenario([{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.org.policies.tag', ne: 'a' } }], [assignment(u('ann'), 'editor', GLOBAL)]);
        await respell();
        await narrower(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8'], ['1', '3']);
      });

      it('a boolean literal against a number attribute other than 0 or 1 is UNKNOWN: restricts, caps and thresholds act (review probes P1, P3, P4)', async () => {
        // o1's level is 3; the rules sit at o1.
        const rows = [assignment(u('ann'), 'editor', GLOBAL)];
        for (const when of [
          { attr: 'scope.org.policies.level', eq: true },
          { attr: 'scope.org.policies.level', ne: false },
        ]) {
          await scenario([{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when }], rows);
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
          await scenario([{ id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'viewer', when }], rows);
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
          await scenario([{ id: 't1', kind: 'threshold', scope: O('o1'), permissions: ['doc:edit'], minRole: 'maintainer', when }], rows);
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        }
      });

      it('cap: constant, ref through scope attributes, drop, strip, subject and scope selectors; implied roles go with their clamped source unless bypassed', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'viewer' },
            { id: 'c2', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' }, assignments: { subjectTypes: ['team'] } },
            { id: 'c3', kind: 'cap', scope: P('11'), ladder: 'project', maxRole: null },
            { id: 'c4', kind: 'cap', scope: P('10'), stripTags: true },
            { id: 'c5', kind: 'cap', scope: O('o2'), ladder: 'org', maxRole: 'org.guest' },
            { id: 'c6', kind: 'cap', scope: P('13'), ladder: 'project', maxRole: 'commenter', assignments: { scopeTypes: ['project'] } },
          ],
          [assignment(u('ann'), 'editor', GLOBAL, { tags: ['inspect'] }), assignment(u('ann'), 'editor', P('13')), assignment(u('cid'), 'org.owner', O('o1')), assignment(u('cyd'), 'org.owner', O('o2')), assignment(u('dan'), 'support', GLOBAL), assignment(u('gus'), 'team.member', at('team', 't1')), assignment(team('t1'), 'maintainer', GLOBAL), assignment(u('eve'), 'auditor', GLOBAL), assignment(u('eve'), 'projectOnly', P('12'))],
        );
        // c2 reads every row's org: docs 6, 7 and 8 have an org node without a row, which faults for everyone.
        await lists(user('ann'), 'doc:edit', ['2', '4', '5']);
        await lists(user('ann'), 'doc:read', ['1', '2', '4', '5']);
        await lists(user('ann'), 'doc:inspect', ['4', '5']);
        await lists(user('cid'), 'doc:read', ['1']);
        await lists(user('cid'), 'doc:edit', []);
        await lists(user('cid'), 'doc:inspect', []);
        await lists(user('cyd'), 'doc:read', []);
        await lists(user('dan'), 'doc:read', ['1', '2', '3', '4', '5']);
        // c2 caps the set's maintainer by the org's max_role; at doc 5 (no org) it would act on the set, so it faults.
        await lists(user('gus'), 'doc:edit', ['2', '4']);
        await lists(user('gus'), 'doc:read', ['1', '2', '4']);
        // auditor is off the ladder and reaches commenter: c3 drops it below project 11.
        await lists(user('eve'), 'doc:comment', ['2', '4', '5']);
        await lists(user('eve'), 'doc:edit', ['5']);
      });

      it('cap: rank selectors read the ranks after restrict', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } },
            { id: 'r1', kind: 'restrict', scope: O('o1'), allow: [] },
          ],
          [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', P('10'))],
        );
        // Under o1 the restrict drops the GLOBAL editor first, so the cap does not select ann at doc 1.
        await lists(user('ann'), 'doc:comment', ['1', '4']);
      });

      it('cap: a ref on a node the row lacks faults only where the cap would act; an indeterminate rule refuses its path', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'org', maxRole: { ref: 'scope.project.org_max' } },
            { id: 'c2', kind: 'cap', scope: P('12'), ladder: 'project', maxRole: { ref: 'principal.attributes.max' } },
            { id: 'c3', kind: 'cap', scope: P('11'), stripTags: true, when: { attr: 'scope.org.policies.tag', eq: 'a' } },
          ],
          [assignment(u('ann'), 'editor', GLOBAL, { tags: ['inspect'] }), assignment(u('fay'), 'org.guest', GLOBAL), assignment(u('fay'), 'viewer', GLOBAL)],
        );
        // c1 reads scope.project.*: only doc 4 lacks a project, where ann's project roles do not act; elsewhere org_max is missing for everyone.
        await lists(user('ann'), 'doc:edit', ['4']);
        await lists(user('fay'), 'doc:read', []);
        await lists(user('ann'), 'doc:inspect', ['4']);
      });

      it('threshold: constant, ladder/at, a ref, a when on a scope attribute, a resource wildcard, provenance rank', async () => {
        await scenario(
          [
            { id: 't1', kind: 'threshold', scope: P('10'), permissions: ['doc:edit'], minRole: 'maintainer' },
            { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['doc:read'], ladder: 'org', at: 'org', minRole: 'org.guest' },
            { id: 't3', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: { ref: 'scope.org.policies.min_role' } },
            { id: 't4', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.locked', eq: true } },
            { id: 't5', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer', resource: { attr: 'resource.name', wildcard: 'release/*' } },
            { id: 't6', kind: 'threshold', scope: GLOBAL, permissions: ['doc:audit'], minRole: 'maintainer' },
          ],
          [assignment(u('ann'), 'editor', GLOBAL), assignment(u('mia'), 'maintainer', GLOBAL), assignment(u('bea'), 'org.guest', O('o1')), assignment(u('bea'), 'viewer', GLOBAL), assignment(u('eve'), 'editor', P('10')), assignment(u('eve'), 'maintainer', O('o1')), assignment(u('dot'), 'maintainer', P('10')), assignment(u('kay'), 'commenter', GLOBAL)],
        );
        await lists(user('ann'), 'doc:edit', ['4']);
        await lists(user('mia'), 'doc:edit', ['1', '2', '3', '4', '5']);
        await lists(user('ann'), 'doc:read', []);
        await lists(user('bea'), 'doc:read', ['1', '3']);
        await lists(user('ann'), 'doc:comment', ['1', '2', '3', '4']);
        await lists(user('kay'), 'doc:comment', ['2', '4']);
        // Every doc:audit grant on the project ladder has grantedAt: the deciding rank counts only assignments made at project or GLOBAL.
        await lists(user('eve'), 'doc:audit', []);
        await lists(user('dot'), 'doc:audit', ['1', '2', '7']);
      });

      it('threshold: caps lower the deciding rank, rank selectors, implied ranks, glob patterns, an indeterminate threshold', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'editor' },
            { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['doc:read'], minRole: 'maintainer', subjects: { rank: { ladder: 'project', at: 'project', lt: 'editor' } } },
            { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer' },
            { id: 't3', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'release/*' } },
            { id: 't4', kind: 'threshold', scope: P('11'), permissions: ['doc:inspect'], minRole: { ref: 'principal.attributes.min' } },
          ],
          [assignment(u('mia'), 'maintainer', GLOBAL, { tags: ['inspect'] }), assignment(u('cid'), 'org.owner', O('o1')), assignment(u('cid'), 'viewer', GLOBAL), assignment(u('ivy'), 'viewer', P('10')), assignment(u('ivy'), 'editor', P('11')), assignment(u('kay'), 'commenter', GLOBAL)],
        );
        await lists(user('mia'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        await lists(user('cid'), 'doc:edit', []);
        await lists(user('ivy'), 'doc:read', ['3', '8']);
        // A glob's * stops at '/'; doc 8's name is null (UNKNOWN: denied).
        await lists(user('kay'), 'doc:comment', ['2', '3', '4', '6', '7']);
        await lists(user('mia'), 'doc:inspect', ['1', '2', '4', '5', '6', '7']);
      });

      it('threshold: a resource condition never keeps the gathering from reading a { ref } or from refusing a minRole of another ladder', async () => {
        await scenario(
          [
            // o2's min_role is the default 'commenter', of the project ladder: the threshold step throws (denies) wherever the rule applies.
            { id: 't1', kind: 'threshold', scope: O('o2'), permissions: ['doc:comment'], ladder: 'org', minRole: { ref: 'scope.org.policies.min_role' }, resource: { attr: 'resource.name', wildcard: 'zzz*' } },
            // The gathering reads the missing nomin where when is not FALSE, and a resource.* leaf is no FALSE there.
            { id: 't2', kind: 'threshold', scope: O('o1'), permissions: ['doc:comment'], minRole: { ref: 'scope.org.policies.nomin' }, when: { attr: 'resource.name', wildcard: 'zzz*' } },
            {
              id: 't3',
              kind: 'threshold',
              scope: P('12'),
              permissions: ['doc:comment'],
              minRole: 'maintainer',
              when: {
                all: [
                  { attr: 'resource.name', wildcard: 'zzz*' },
                  { attr: 'scope.project.tier', eq: 'gold' },
                ],
              },
            },
          ],
          [assignment(u('ann'), 'editor', GLOBAL)],
        );
        await lists(user('ann'), 'doc:comment', ['5', '6', '7', '8']);
      });

      it('threshold: UNKNOWN in when or resource denies; missing attributes and nodes deny', async () => {
        await scenario(
          [
            { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['doc:read'], minRole: 'maintainer', when: { attr: 'principal.attributes.contractor', eq: true } },
            { id: 't2', kind: 'threshold', scope: O('o2'), permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.level', gte: 2 } },
            { id: 't3', kind: 'threshold', scope: O('o1'), permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.level', gte: 2 } },
            { id: 't4', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', when: { attr: 'scope.org.policies.mode', eq: 'x' } },
            { id: 't5', kind: 'threshold', scope: GLOBAL, permissions: ['doc:audit'], minRole: 'maintainer', when: { attr: 'scope.$global.mode', eq: 'strict' } },
          ],
          [assignment(u('ann'), 'editor', GLOBAL)],
        );
        await lists(user('ann'), 'doc:read', []);
        await lists({ ...user('ann'), attributes: { contractor: false } } as Principal, 'doc:read', ALL);
        await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        // scope.org.policies.mode exists on no org: a fault wherever the rule applies, and no org node at doc 5.
        await lists(user('ann'), 'doc:comment', []);
        await lists(user('ann'), 'doc:audit', []);
      });

      it('narrower than the check, as documented: a null maxRole ref, a scope pattern leaf, a resource leaf other than a pattern', async () => {
        await world.configure({ rules: [{ id: 'c1', kind: 'cap', scope: O('o2'), ladder: 'project', maxRole: { ref: 'scope.org.policies.none' } }], schemas: [{ scopeType: 'org', schema: {}, defaults: { policies: { none: null } } }], attributes: ATTRS });
        await world.assign([assignment(u('ann'), 'projectOnly', P('10'))]);
        // The null default makes maxRole null at o2 in the check, which drops ladder roles only; SQL cannot tell null from missing and refuses doc 2.
        await narrower(user('ann'), 'doc:edit', ['1', '7'], ['2']);
        await scenario([{ id: 't1', kind: 'threshold', scope: O('o1'), permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.tag', wildcard: 'z*' } }], [assignment(u('ann'), 'editor', GLOBAL)]);
        await narrower(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8'], ['1', '3']);
        await scenario([{ id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', resource: { attr: 'resource.name', eq: 'notes' } }], [assignment(u('ann'), 'editor', GLOBAL)]);
        // doc 2 is 'notes' (denied), doc 8's name is null (UNKNOWN: denied).
        await narrower(user('ann'), 'doc:comment', [], ['1', '3', '4', '5', '6', '7']);
      });

      it('a canvas-like set of a dozen caps and thresholds at GLOBAL (design §8.5 shapes): the terms stay within the SQLite parser stack', async () => {
        const rank = (op: 'lt' | 'eq', role: string) => ({ rank: { ladder: 'org', at: 'org', [op]: role } as { ladder: string; at: string; lt?: string; eq?: string } });
        const policies = (p: Record<string, unknown>) => ({ policies: p });
        await world.configure({
          rules: [
            { id: 'file-grant-cap', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['doc'] } },
            { id: 'link-cap', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'commenter', assignments: { subjectTypes: ['service'] } },
            { id: 'link-org-cap', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_link_role' }, assignments: { subjectTypes: ['team'] } },
            { id: 'guest-cap', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'editor', subjects: rank('eq', 'org.guest') },
            { id: 'guest-org-cap', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.guest_max_role' }, subjects: rank('eq', 'org.guest') },
            { id: 'external-cap', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.external_max_role' }, subjects: { principalTypes: ['user'], ...rank('lt', 'org.guest') } },
            { id: 'external-sharing-off', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: null, subjects: { principalTypes: ['user'], ...rank('lt', 'org.guest') }, assignments: { subjectTypes: ['user', 'team'] }, when: { attr: 'scope.org.policies.external_sharing', eq: false } },
            { id: 'guest-addons', kind: 'cap', scope: GLOBAL, stripTags: true, subjects: { principalTypes: ['user'], ...rank('lt', 'org.owner') }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
            {
              id: 'link-members-only',
              kind: 'threshold',
              scope: GLOBAL,
              permissions: ['*'],
              subjects: { principalTypes: ['service'] },
              when: {
                any: [
                  { attr: 'principal.attributes.org_only', eq: true },
                  { attr: 'scope.org.policies.public_links', eq: false },
                ],
              },
              ladder: 'org',
              at: 'org',
              minRole: 'org.guest',
            },
            { id: 'no-download', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit', 'doc:inspect'], minRole: 'editor', when: { attr: 'scope.org.policies.viewers_may_download', eq: false } },
            { id: 'delete-needs-org-admin', kind: 'threshold', scope: GLOBAL, permissions: ['doc:review'], ladder: 'org', at: 'org', minRole: 'org.admin', when: { attr: 'scope.org.policies.maintainers_may_delete', eq: false } },
          ],
          schemas: [{ scopeType: 'org', schema: {}, defaults: policies({ max_link_role: 'commenter', guest_max_role: 'commenter', external_max_role: 'viewer', external_sharing: true, addons_for_guests: true, public_links: true, viewers_may_download: true, maintainers_may_delete: true }) }],
          attributes: [
            [O('o1'), policies({ external_sharing: false, addons_for_guests: false, public_links: false, viewers_may_download: false, guest_max_role: 'viewer' })],
            [O('o2'), policies({ maintainers_may_delete: false, max_link_role: 'editor' })],
          ],
        });
        await world.assign([assignment(u('ann'), 'org.guest', O('o1')), assignment(u('ann'), 'maintainer', P('10'), { tags: ['inspect', 'review'] }), assignment(u('bea'), 'org.owner', O('o2')), assignment(u('bea'), 'editor', D('4'), { tags: ['inspect'] }), assignment(u('cid'), 'maintainer', GLOBAL, { tags: ['inspect'] }), assignment(u('gus'), 'team.member', at('team', 't1')), assignment(team('t1'), 'maintainer', P('11')), assignment({ type: 'service', id: 's1' }, 'editor', P('10'))]);
        let listed = 0;
        for (const p of [user('ann'), user('bea'), user('cid'), user('gus'), service('s1'), { ...service('s2'), attributes: { org_only: true } } as Principal]) {
          for (const permission of ['doc:read', 'doc:edit', 'doc:inspect', 'doc:review']) {
            await lists(p, permission);
            listed += (await world.allowed(p, permission)).length;
          }
        }
        expect(listed, 'rows listed').to.be.at.least(10);
      });

      it('hand-built args: config roles under rules, a request principal the compilers do not read, refusals', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'viewer' },
            { id: 't1', kind: 'threshold', scope: P('10'), permissions: ['doc:edit'], minRole: 'maintainer' },
          ],
          [assignment(u('ann'), 'editor', GLOBAL)],
        );
        const residual = await world.residual(user('ann'), 'doc:edit');
        const [route] = routeArgs(residual) as unknown as RbacAssignmentArgsV2[];
        const [threshold] = thresholdArgs(residual) as unknown as RbacThresholdArgs[];
        expect(route.rules.map((r) => r.id)).to.deep.equal(['c1', 't1']);
        const { v: _v, route: r, ...ctx } = parseRbacListArgs(RBAC_ASSIGNMENT_OP, route);
        const term = (op: string, args: unknown) => ({ op, args } as unknown as ResourceFilter);
        const both = async (f: ResourceFilter, want: readonly string[]) => {
          expect(await world.compiled(f, user('ann')), `${kind} ${JSON.stringify(f)}`).to.deep.equal(want);
          // E3: the compilers read the principal from the args only.
          expect(await world.compiled(f, user('nobody')), `${kind} another principal`).to.deep.equal(want);
          expect(await world.inMemory(f, user('ann')), `${kind} in memory`).to.deep.equal(want);
        };
        // The compilers read authz.orm.domain only to name a refusal (review M4).
        const proto = RbacListCompiler.prototype as unknown as { where(type: string): string };
        const where = proto.where;
        let domainReads = 0;
        proto.where = function (this: unknown, type: string) {
          domainReads++;
          return where.call(this, type);
        };
        try {
          await both(term(RBAC_ASSIGNMENT_OP, route), ['2', '4', '5', '6', '7', '8']);
          await both(term(RBAC_THRESHOLD_OP, threshold), ['1', '2', '7']);
        } finally {
          proto.where = where;
        }
        expect(domainReads, 'domain reads of terms that compile').to.equal(0);
        // A config role (a constant GLOBAL assignment) under the same rules.
        const config = { ...ctx, subjects: [], config: [{ subject: { type: 'service', id: 'z' }, role: 'editor' }] };
        await both(term(RBAC_ASSIGNMENT_OP, rbacAssignmentArgsV2(config, r)), ['2', '4', '5', '6', '7', '8']);
        await both(term(RBAC_THRESHOLD_OP, rbacThresholdArgs({ ...config, permission: 'doc:edit' }, { rule: 't1' })), ['1', '2', '7']);
        const refused = async (f: ResourceFilter, why: RegExp) => {
          const e = await world.compiled(f, user('ann')).then(
            () => undefined,
            (err: unknown) => err,
          );
          expect(e, String(why)).to.be.instanceOf(AuthzConfigError);
          expect((e as Error).message).to.match(why);
        };
        // No stored rule: dbRules and { db: true } add nothing to the bound rules.
        expect(await world.compiled(term(RBAC_ASSIGNMENT_OP, rbacAssignmentArgsV2({ ...ctx, dbRules: true }, r)), user('ann'))).to.deep.equal(['2', '4', '5', '6', '7', '8']);
        expect(await world.compiled(term(RBAC_THRESHOLD_OP, rbacThresholdArgs({ ...ctx, permission: 'doc:edit' }, { db: true })), user('ann'))).to.deep.equal([]);
        await refused(term(RBAC_THRESHOLD_OP, rbacThresholdArgs({ ...ctx, permission: 'doc:edit' }, { rule: 'nope' })), /names no threshold rule 'nope'/);
        const fn = { ...ctx, rules: [{ id: 'f1', kind: 'cap' as const, scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { fn: 'time.between', args: { from: '00:00', to: '23:59' } } }] };
        await refused(term(RBAC_ASSIGNMENT_OP, rbacAssignmentArgsV2(fn, r)), /rule 'f1'.*condition SQL cannot follow/);
        const stale = { ...ctx, rules: [{ id: 's1', kind: 'cap' as const, scope: GLOBAL, ladder: 'project', maxRole: 'org.guest' }] };
        await refused(term(RBAC_ASSIGNMENT_OP, rbacAssignmentArgsV2(stale, r)), /domain "l4broute\d+", type 'doc'\) rule 's1'.*roles changed/);
      });

      it('SQLite: a term deeper than the parser stack allows is refused at compile time, naming the rule; Postgres has no such limit', async () => {
        const leaf = (i: number) => (i % 2 ? { attr: 'scope.org.policies.level', gte: 2 } : { attr: 'scope.org.policies.tag', eq: 'a' });
        // 3d + 1 condition levels: not(any(leaf, all(leaf, …))) d times.
        const deep = (d: number): NonNullable<Rule['when']> => {
          let c: NonNullable<Rule['when']> = leaf(0);
          for (let i = 0; i < d; i++) c = { not: { any: [leaf(i + 1), { all: [leaf(i), c] }] } };
          return c;
        };
        const cap = (d: number): Rule[] => [{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: deep(d) }];
        const combo = (d: number): Rule[] => [
          { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: { attr: 'scope.org.policies.tag', eq: 'a' }, subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } },
          { id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: deep(d), subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } },
          { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.locked', eq: true } },
        ];
        const rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', P('10'))];
        const refusedOnSqlite = async (permission: string, rule: string) => {
          if (kind === 'postgres') {
            await lists(user('ann'), permission);
            return;
          }
          const e = await world.listed(user('ann'), permission).then(
            () => undefined,
            (err: unknown) => err,
          );
          expect(e, `${kind} ${permission}`).to.be.instanceOf(AuthzConfigError);
          expect((e as Error).message).to.match(new RegExp(`type 'doc'\\) rule '${rule}'.*SQLite's parser stack`));
        };
        // The deepest accepted: 7 condition levels in a cap's when, 4 in a restrict's beside rank selectors.
        await scenario(cap(2), rows);
        await lists(user('ann'), 'doc:edit');
        await lists(user('ann'), 'doc:comment');
        await scenario(cap(3), rows);
        await refusedOnSqlite('doc:edit', 'c1');
        await scenario(combo(1), rows);
        await lists(user('ann'), 'doc:edit');
        await lists(user('ann'), 'doc:comment');
        await scenario(combo(2), rows);
        await refusedOnSqlite('doc:comment', 'r1');
      });

      if (kind === 'sqlite') {
        it('the parser depth estimate follows SQLite: it never reads a shape more than 2 symbols shallower than SQLite does', async () => {
          const overflows = async (sql: string) =>
            db.raw('sqlite', sql).then(
              () => false,
              (e: unknown) => /parser stack overflow/.test(String((e as Error)?.message ?? e) + String((e as { cause?: Error })?.cause?.message ?? '')),
            );
          // The most brackets SQLite takes around `frag` in a WHERE: 100 less the frame and frag's own depth.
          const headroom = async (frag: string) => {
            let lo = 0;
            let hi = 99;
            while (lo < hi) {
              const k = Math.ceil((lo + hi) / 2);
              if (await overflows(`SELECT 1 FROM t WHERE ${'('.repeat(k)}${frag}${')'.repeat(k)}`)) hi = k - 1;
              else lo = k;
            }
            return lo;
          };
          const shapes: Record<string, (d: number) => string> = {
            brackets: (d) => '('.repeat(d) + '1' + ')'.repeat(d),
            and: (d) => '1 AND ('.repeat(d) + '1' + ')'.repeat(d),
            not: (d) => 'NOT ('.repeat(d) + '1' + ')'.repeat(d),
            notExists: (d) => '(NOT EXISTS (SELECT 1 FROM t WHERE '.repeat(d) + '1' + '))'.repeat(d),
            caseList: (d) => 'CASE WHEN 1 = 1 THEN 2 WHEN 1 = 0 THEN '.repeat(d) + '1' + ' END'.repeat(d),
            caseCond: (d) => '(CASE WHEN '.repeat(d) + '1 = 1' + ' THEN 1 END = 1)'.repeat(d),
            derived: (d) => '(SELECT a FROM ('.repeat(d) + 'SELECT 1 AS a' + ') x)'.repeat(d) + ' = 1',
            crossJoin: (d) => '(SELECT COUNT(*) FROM (SELECT x.*, 1 AS b FROM (SELECT 1 AS a) y CROSS JOIN ('.repeat(d) + 'SELECT 1 AS a' + ') x WHERE x.a = 1) z WHERE z.b = 1)'.repeat(d) + ' = 1',
            functions: (d) => 'SUBSTR('.repeat(d) + 'a' + ', 1, 1)'.repeat(d) + ' = 1',
            mixed: (d) => '(a IS NOT NULL AND (b = 1 OR NOT (c IN (1, 2) AND '.repeat(d) + '1' + ')))'.repeat(d),
            between: (d) => '(typeof(a) IN (1, 2) AND a BETWEEN -9 AND 9 AND ('.repeat(d) + '1' + '))'.repeat(d),
            glob: (d) => '(a GLOB b AND NOT (a GLOB c) AND instr(a, char(0)) = 0 AND a = b COLLATE BINARY AND ('.repeat(d) + '1' + '))'.repeat(d),
            // The WITH of a term with stored rules: depth in a table, in a later table, in the select after them.
            withFirst: (d) => `(WITH a AS MATERIALIZED (SELECT 1 AS v FROM t WHERE ${'NOT ('.repeat(d)}1${')'.repeat(d)}), b AS MATERIALIZED (SELECT 1 AS w) SELECT COUNT(*) FROM a) = 1`,
            withLater: (d) => `(WITH a AS MATERIALIZED (SELECT 1 AS v), b AS MATERIALIZED (SELECT v FROM a), c AS MATERIALIZED (SELECT v FROM b WHERE ${'(NOT EXISTS (SELECT 1 FROM a WHERE '.repeat(d)}1${'))'.repeat(d)}) SELECT COUNT(*) FROM c) = 1`,
            withSelect: (d) => `(WITH a AS MATERIALIZED (SELECT 1 AS v), b AS MATERIALIZED (SELECT v FROM a) SELECT COUNT(*) FROM b WHERE ${'1 AND ('.repeat(d)}1${')'.repeat(d)}) = 1`,
          };
          const base = sqliteParserDepth(new RbacSql(['1'])) + (await headroom('1'));
          for (const [name, shape] of Object.entries(shapes)) {
            for (const d of [1, 3, 6]) {
              const frag = shape(d);
              const sum = sqliteParserDepth(new RbacSql([frag])) + (await headroom(frag));
              expect(sum, `${name} at ${d}: estimate + headroom against ${base} for a bare value`).to.be.within(base - 2, base + 4);
            }
          }
        });

        it('a row the adapter cannot find, or by an id SQL cannot print, is UNKNOWN: neither a rule term nor its NOT lists it', async () => {
          await scenario(
            [
              { id: 'c1', kind: 'cap', scope: O('o2'), ladder: 'project', maxRole: 'viewer' },
              { id: 't1', kind: 'threshold', scope: P('10'), permissions: ['doc:edit'], minRole: 'maintainer' },
            ],
            [assignment(u('ann'), 'editor', GLOBAL)],
          );
          const residual = await world.residual(user('ann'), 'doc:edit');
          await db.insert(world.models.Doc, SQLITE_ODD_DOCS);
          try {
            for (const [op, args] of [...routeArgs(residual).map((a) => [RBAC_ASSIGNMENT_OP, a] as const), ...thresholdArgs(residual).map((a) => [RBAC_THRESHOLD_OP, a] as const)]) {
              const term = { op, args } as unknown as ResourceFilter;
              const yes = await world.compiled(term, user('ann'));
              const no = await world.compiled({ op: 'not', arg: term }, user('ann'));
              expect(
                yes.filter((id) => no.includes(id)),
                op,
              ).to.deep.equal([]);
              expect([...yes, ...no].sort(), op).to.deep.equal((await world.docIds()).filter((id) => id !== '9.5' && id !== 'x9'));
            }
          } finally {
            await db.raw(kind, `DELETE FROM "${db.table(world.models.Doc)}" WHERE "id" IN ('x9', 9.5, 20)`);
          }
        });
      }

      it('the scenarios compiled rule terms', () => {
        expect(terms.route, 'route terms with rules').to.be.at.least(20);
        expect(terms.threshold, 'threshold terms').to.be.at.least(10);
      });
    });
  }
});
