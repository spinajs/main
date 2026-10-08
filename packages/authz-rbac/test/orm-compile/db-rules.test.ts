import { GLOBAL } from '@spinajs/authz';
import type { Assignment, Principal, ResourceFilter, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { toSqlForm } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { LADDERS, RouteWorld, assignment, at, registerRouteSources, routeArgs, service, team, thresholdArgs, u, user } from './route-world.js';
import type { RawRuleRow } from './route-world.js';

/*
 * L4b task "db": the rules of the model's DbRuleStore in SQL (args v2 `dbRules: true`, native:rbac.threshold
 * `{ db: true }`), alone and beside bound config rules. For every case, per row: check() (the row as subject) = the
 * rows authz-orm lists = the in-memory list filter. Docs (ORM_DOCS): 1 p10/o1, 2 p10/o2, 3 p11/o1, 4 -/o2, 5 p12/-,
 * 6 p13/'', 7 p10/'O1', 8 p11/'o10'; org rows o1 and o2 only. Names: 1 'release/1', 2 'notes', 3 'release/2/fix',
 * 4 'Release/3', 5 'release/', 6 'releasе/1', 7 'release_1', 8 null. Most scenarios are the config-rule scenarios of
 * rules.test.ts stored instead, with the same expectations: the check treats both stores' rules alike.
 */

type Rule = Omit<RuleDef, 'source'>;

const ALL = ['1', '2', '3', '4', '5', '6', '7', '8'];
const P = (id: string) => at('project', id);
const O = (id: string) => at('org', id);
const D = (id: string) => at('doc', id);
const DAY = 24 * 3600 * 1000;

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

/** An `authz_rule` row as the store writes `rule`, with its definition replaced by `definition` (what no store write gives). */
function rawRule(rule: Rule, definition: Record<string, unknown>): RawRuleRow {
  const form = toSqlForm(rule, LADDERS);
  return { rule: { ...form.rule, definition: JSON.stringify(definition) }, subjects: form.subjects.map((s) => ({ ...s })) };
}

describe('authz-rbac orm-compile: stored rules (DbRuleStore) in SQL', function () {
  this.timeout(1800000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_db_rules');
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

      async function scenario(dbRules: readonly Rule[], rows: readonly Assignment[], rules: readonly Rule[] = [], raw: readonly RawRuleRow[] = []): Promise<void> {
        await world.configure({ rules, dbRules, schemas: SCHEMAS, attributes: ATTRS });
        if (raw.length > 0) await world.writeRawRules(raw);
        await world.assign(rows);
      }

      // Test constants only: no quote in any of them.
      const setValue = (scopeType: string, scopeId: string, path: string, json: string) => db.raw(kind, `UPDATE "authz_scope_attribute" SET "value_json" = '${json}' WHERE "scope_type" = '${scopeType}' AND "scope_id" = '${scopeId}' AND "path" = '${path}'`);

      /** B06 for `p`: check() per row = listed through authz-orm = the in-memory list filter (= `want` when given). */
      async function lists(p: Principal, permission: string, want?: readonly string[]): Promise<ResourceFilter> {
        const residual = await world.residual(p, permission);
        const allowed = await world.allowed(p, permission);
        const why = `${kind} ${p.id} ${permission}: ${JSON.stringify(residual)}`;
        const routes = routeArgs(residual);
        const thresholds = thresholdArgs(residual);
        expect(
          [...routes, ...thresholds].every((a) => a.dbRules === true),
          `stored-rule terms, ${why}`,
        ).to.equal(true);
        terms.route += routes.length;
        terms.threshold += thresholds.length;
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
        await lists(user('dan'), 'doc:read', ALL);
        await lists(user('gus'), 'doc:edit', ['4', '5', '6', '8']);
        await lists(user('hal'), 'doc:edit', ['5', '6', '8']);
        await lists(service('s1'), 'doc:read', ALL);
        await lists(service('s2'), 'doc:edit', ['5', '6', '8']);
      });

      it('restrict: rank selectors read the ranks after collect; principal type and refs selectors; a rule without its node faults only where it would drop', async () => {
        await scenario(
          [
            { id: 'r1', kind: 'restrict', scope: O('o1'), subjects: { rank: { ladder: 'project', at: 'project', lt: 'editor' } }, allow: [] },
            { id: 'r2', kind: 'restrict', scope: O('o2'), subjects: { principalTypes: ['service'] }, allow: [] },
            { id: 'r3', kind: 'restrict', scope: GLOBAL, when: { attr: 'scope.project.tier', eq: 'gold' }, allow: [] },
            { id: 'r4', kind: 'restrict', scope: P('11'), subjects: { refs: [{ type: 'user', id: 'bea' }] }, allow: [] },
          ],
          [assignment(u('ann'), 'viewer', P('10')), assignment(u('ann'), 'viewer', GLOBAL), assignment(u('bea'), 'editor', P('11')), assignment(u('bea'), 'viewer', GLOBAL), assignment(u('cid'), 'viewer', at('doc')), assignment(u('dan'), 'maintainer', O('o2')), assignment(u('eli'), 'editor', GLOBAL)],
        );
        // eli's GLOBAL editor ranks at every project: r1 does not select eli, so it keeps what it would drop.
        await lists(user('eli'), 'doc:read', ALL);
        await lists(user('ann'), 'doc:read', ['1', '2', '4', '5', '6', '7', '8']);
        // r4 selects bea: her GLOBAL viewer goes under project 11 (docs 3, 8); her editor at project 11 stays.
        await lists(user('bea'), 'doc:read', ['2', '3', '4', '5', '6', '7', '8']);
        await lists(user('bea'), 'doc:edit', ['3', '8']);
        // cid's type-only viewer: r3 at GLOBAL drops it where it applies, and faults at doc 4 (no project node).
        await lists(user('cid'), 'doc:read');
        await lists(user('dan'), 'doc:read', ['2', '4']);
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
        await lists(user('ann'), 'doc:edit', ['2', '4', '5']);
        await lists(user('ann'), 'doc:read', ['1', '2', '4', '5']);
        await lists(user('ann'), 'doc:inspect', ['4', '5']);
        await lists(user('cid'), 'doc:read', ['1']);
        await lists(user('cid'), 'doc:inspect', []);
        await lists(user('cyd'), 'doc:read', []);
        await lists(user('dan'), 'doc:read', ['1', '2', '3', '4', '5']);
        await lists(user('gus'), 'doc:edit', ['2', '4']);
        await lists(user('gus'), 'doc:read', ['1', '2', '4']);
        await lists(user('eve'), 'doc:comment', ['2', '4', '5']);
        await lists(user('eve'), 'doc:edit', ['5']);
      });

      it('cap: rank selectors read the ranks after restrict, whichever store holds the cap and the restrict', async () => {
        const cap: Rule = { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } };
        const restrict: Rule = { id: 'r1', kind: 'restrict', scope: O('o1'), allow: [] };
        const rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', P('10'))];
        await scenario([cap, restrict], rows);
        await lists(user('ann'), 'doc:comment', ['1', '4']);
        await scenario([cap], rows, [restrict]);
        await lists(user('ann'), 'doc:comment', ['1', '4']);
        await scenario([restrict], rows, [cap]);
        await lists(user('ann'), 'doc:comment', ['1', '4']);
      });

      it('cap: a ref on a node the row lacks faults only where the cap would act; a strip whose when reads an attribute', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'org', maxRole: { ref: 'scope.project.org_max' } },
            { id: 'c3', kind: 'cap', scope: P('11'), stripTags: true, when: { attr: 'scope.org.policies.tag', eq: 'a' } },
          ],
          [assignment(u('ann'), 'editor', GLOBAL, { tags: ['inspect'] }), assignment(u('fay'), 'org.guest', GLOBAL), assignment(u('fay'), 'viewer', GLOBAL)],
        );
        await lists(user('ann'), 'doc:edit', ['4']);
        await lists(user('fay'), 'doc:read', []);
        await lists(user('ann'), 'doc:inspect', ['4']);
      });

      it('threshold { db: true }: constant, ladder/at, a ref, a when on a scope attribute, a resource wildcard, provenance rank', async () => {
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
        await lists(user('eve'), 'doc:audit', []);
        await lists(user('dot'), 'doc:audit', ['1', '2', '7']);
      });

      it('threshold { db: true }: caps lower the deciding rank, rank selectors, implied ranks, glob patterns; another ladder refused wherever the rule applies', async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'editor' },
            { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['doc:read'], minRole: 'maintainer', subjects: { rank: { ladder: 'project', at: 'project', lt: 'editor' } } },
            { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer' },
            { id: 't3', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', resource: { attr: 'resource.name', glob: 'release/*' } },
            // o2's min_role is the default 'commenter', of the project ladder: the step throws (denies) wherever the rule applies.
            { id: 't4', kind: 'threshold', scope: O('o2'), permissions: ['doc:inspect'], ladder: 'org', minRole: { ref: 'scope.org.policies.min_role' }, resource: { attr: 'resource.name', wildcard: 'zzz*' } },
          ],
          [assignment(u('mia'), 'maintainer', GLOBAL, { tags: ['inspect'] }), assignment(u('cid'), 'org.owner', O('o1')), assignment(u('cid'), 'viewer', GLOBAL), assignment(u('ivy'), 'viewer', P('10')), assignment(u('ivy'), 'editor', P('11')), assignment(u('kay'), 'commenter', GLOBAL)],
        );
        await lists(user('mia'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        await lists(user('cid'), 'doc:edit', []);
        await lists(user('ivy'), 'doc:read', ['3', '8']);
        await lists(user('kay'), 'doc:comment', ['2', '3', '4', '6', '7']);
        await lists(user('mia'), 'doc:inspect', ['1', '3', '5', '6', '7', '8']);
      });

      it('threshold { db: true }: UNKNOWN or a missing attribute or node denies', async () => {
        await scenario(
          [
            { id: 't2', kind: 'threshold', scope: O('o2'), permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.level', gte: 2 } },
            { id: 't3', kind: 'threshold', scope: O('o1'), permissions: ['doc:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.level', gte: 2 } },
            { id: 't4', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', when: { attr: 'scope.org.policies.mode', eq: 'x' } },
            { id: 't5', kind: 'threshold', scope: GLOBAL, permissions: ['doc:audit'], minRole: 'maintainer', when: { attr: 'scope.$global.mode', eq: 'strict' } },
            { id: 't6', kind: 'threshold', scope: GLOBAL, permissions: ['doc:read'], minRole: 'maintainer', when: { attr: 'scope.org.policies.level', eq: 'x' } },
          ],
          [assignment(u('ann'), 'editor', GLOBAL)],
        );
        await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        await lists(user('ann'), 'doc:comment', []);
        await lists(user('ann'), 'doc:audit', []);
        // A number attribute against a string that is no number: UNKNOWN, so the threshold denies where it applies.
        await lists(user('ann'), 'doc:read', []);
      });

      it('config and stored rules together: one id order across both stores for the restricts that fault, thresholds of both', async () => {
        const rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', O('o2'))];
        const plain = (id: string): Rule => ({ id, kind: 'restrict', scope: O('o2'), allow: [] });
        // Reads scope.project.*: doc 4 has no project, so the rule is indeterminate there.
        const reading = (id: string): Rule => ({ id, kind: 'restrict', scope: O('o2'), allow: [], when: { attr: 'scope.project.tier', eq: 'gold' } });
        // The plain restrict first drops the GLOBAL editor, so the reading one drops nothing at doc 4.
        await scenario([reading('r2')], rows, [plain('r1')]);
        await lists(user('ann'), 'doc:comment', ALL);
        await scenario([plain('r1')], rows, [reading('r2')]);
        await lists(user('ann'), 'doc:comment', ALL);
        // The reading restrict first would drop the GLOBAL editor at doc 4: the check throws there.
        await scenario([reading('r0')], rows, [plain('r1')]);
        await lists(user('ann'), 'doc:comment', ['1', '2', '3', '5', '6', '7', '8']);
        await scenario([plain('r1')], rows, [reading('r0')]);
        await lists(user('ann'), 'doc:comment', ['1', '2', '3', '5', '6', '7', '8']);
        // A config threshold and a stored one, each its own term.
        await scenario(
          [{ id: 't1', kind: 'threshold', scope: O('o1'), permissions: ['doc:edit'], minRole: 'maintainer' }],
          [assignment(u('ann'), 'editor', GLOBAL)],
          [
            { id: 't2', kind: 'threshold', scope: P('11'), permissions: ['doc:edit'], minRole: 'maintainer' },
            { id: 'c1', kind: 'cap', scope: P('12'), ladder: 'project', maxRole: 'viewer' },
          ],
        );
        const residual = await lists(user('ann'), 'doc:edit', ['2', '4', '6', '7']);
        expect(
          thresholdArgs(residual)
            .map((a) => JSON.stringify(a.threshold))
            .sort(),
        ).to.deep.equal(['{"db":true}', '{"rule":"t2"}']);
      });

      it("a stored restrict or cap whose when reads a missing attribute refuses the row; without the attribute's node it is indeterminate", async () => {
        const missing = { attr: 'scope.org.policies.nothing', eq: true };
        const rows = [assignment(u('ann'), 'editor', GLOBAL)];
        // At doc 5 (no org) the restrict would drop nothing above GLOBAL, so it does not throw there.
        await scenario([{ id: 'r1', kind: 'restrict', scope: GLOBAL, allow: [], when: missing }], rows);
        await lists(user('ann'), 'doc:edit', ['5']);
        // The cap would act on ann's editor at doc 5, so it throws there too.
        await scenario([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', when: missing }], rows);
        await lists(user('ann'), 'doc:read', []);
      });

      it('a stored restrict whose when SQL cannot decide refuses the rows where its choice matters (review probe A, stored)', async () => {
        // o1's level is the string "3": the check reads it as the number 3, so eq 2 is FALSE; SQL cannot tell.
        const rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', P('10'))];
        const cap: Rule = { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } };
        await scenario([{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.org.policies.level', eq: 2 } }, cap], rows);
        await setValue('org', 'o1', 'policies.level', '"3"');
        await lists(user('ann'), 'doc:comment', ['4']);
      });

      it('expiry: an expired stored rule is gone, a live one applies', async () => {
        const now = Date.now();
        await scenario(
          [
            { id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], expiresAt: new Date(now - DAY) },
            { id: 'r2', kind: 'restrict', scope: O('o2'), allow: [], expiresAt: new Date(now + DAY) },
            { id: 't1', kind: 'threshold', scope: P('10'), permissions: ['doc:edit'], minRole: 'maintainer', expiresAt: new Date(now - DAY) },
            { id: 't2', kind: 'threshold', scope: P('11'), permissions: ['doc:edit'], minRole: 'maintainer', expiresAt: new Date(now + DAY) },
          ],
          [assignment(u('ann'), 'editor', GLOBAL)],
        );
        await lists(user('ann'), 'doc:edit', ['1', '5', '6', '7']);
      });

      it('rows past the store: stale rank columns, a role the roles do not hold, a definition beyond the SQL form', async () => {
        const rows = [assignment(u('ann'), 'editor', GLOBAL)];
        // The rank columns say maintainer; the definition, which the check reads, viewer.
        const stale = rawRule({ id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'maintainer' }, { kind: 'cap', ladder: 'project', maxRole: 'viewer' });
        await scenario([], rows, [], [stale]);
        await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        // compileRule refuses a role the roles do not hold: every row on the rule's path fails, whoever asks.
        const unknown = rawRule({ id: 'c1', kind: 'cap', scope: O('o1'), ladder: 'project', maxRole: 'viewer' }, { kind: 'cap', ladder: 'project', maxRole: 'nope' });
        await scenario([], rows, [], [unknown]);
        await lists(user('ann'), 'doc:read', ['2', '4', '5', '6', '7', '8']);
        await lists(service('s1'), 'doc:read', ['2', '4', '5', '6', '7', '8']);
        // A when that reads the principal (D24): the list refuses every row on the path where the rule selects the principal.
        const beyond = rawRule({ id: 'r1', kind: 'restrict', scope: O('o2'), allow: [] }, { kind: 'restrict', allow: [], when: { attr: 'principal.attributes.contractor', eq: true } });
        await scenario([], rows, [], [beyond]);
        await lists(user('ann'), 'doc:read', ['1', '3', '5', '6', '7', '8']);
        // The same for services only: the check refuses nothing for a user, SQL cannot tell and refuses the path.
        const beyondServices = rawRule({ id: 'r1', kind: 'restrict', scope: O('o2'), allow: [], subjects: { principalTypes: ['service'] } }, { kind: 'restrict', allow: [], subjects: { principalTypes: ['service'] }, when: { attr: 'principal.attributes.contractor', eq: true } });
        await scenario([], rows, [], [beyondServices]);
        await narrower(user('ann'), 'doc:read', ['1', '3', '5', '6', '7', '8'], ['2', '4']);
        // A stored threshold beyond D24 denies its path in the { db: true } term.
        const threshold = rawRule({ id: 't1', kind: 'threshold', scope: O('o1'), permissions: ['doc:edit'], minRole: 'viewer' }, { kind: 'threshold', permissions: ['doc:edit'], minRole: { ref: 'principal.attributes.min' } });
        await scenario([], rows, [], [threshold]);
        await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
      });

      it("type-only scopes: a stored cap there applies where a node holds the id ''; a stored restrict there never does; a type-only set in allow refuses the rows of its holders", async () => {
        await scenario(
          [
            { id: 'c1', kind: 'cap', scope: at('org'), ladder: 'project', maxRole: 'viewer' },
            { id: 'r1', kind: 'restrict', scope: at('org'), allow: [] },
          ],
          [assignment(u('ann'), 'editor', GLOBAL)],
        );
        await lists(user('ann'), 'doc:edit', ['1', '2', '3', '4', '5', '7', '8']);
        await lists(user('ann'), 'doc:read', ALL);
        const typeOnlyTeam = { set: { role: 'team.member', scope: at('team') } };
        await scenario([{ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [typeOnlyTeam] }], [assignment(u('gus'), 'team.member', at('team')), assignment(typeOnlyTeam, 'editor', GLOBAL), assignment(u('gus'), 'viewer', GLOBAL)]);
        await narrower(user('gus'), 'doc:edit', ['2', '4', '5', '6', '7', '8'], ['1', '3']);
        // Dropping the set's editor would be no narrowing here: the rank-selected cap would then miss gus at doc 1 and
        // leave his commenter, which the check clamps to viewer.
        await scenario(
          [
            { id: 'r1', kind: 'restrict', scope: O('o1'), allow: [typeOnlyTeam] },
            { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } },
          ],
          [assignment(u('gus'), 'team.member', at('team')), assignment(typeOnlyTeam, 'editor', GLOBAL), assignment(u('gus'), 'commenter', P('10'))],
        );
        // Doc 4 has no project, so no rank there: the cap does not select gus.
        await lists(user('gus'), 'doc:comment', ['4']);
        await narrower(user('gus'), 'doc:read', ['2', '4', '5', '6', '7', '8'], ['1', '3']);
      });

      it('number attributes compare by value, not by their JSON text (N1); a text longer than SQL can follow is inexact', async () => {
        const rows = [assignment(u('ann'), 'editor', GLOBAL)];
        const restrict = (when: NonNullable<Rule['when']>): Rule => ({ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when });
        // The same restrict as a config rule (rules.ts) and as a stored one (db-rules.ts).
        for (const store of ['config', 'db'] as const) {
          const put = async (when: NonNullable<Rule['when']>, path: string, json: string) => {
            await scenario(store === 'db' ? [restrict(when)] : [], rows, store === 'config' ? [restrict(when)] : []);
            await setValue('org', 'o1', path, json);
          };
          await put({ attr: 'scope.org.policies.level', eq: 3 }, 'policies.level', '3.0');
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
          await put({ attr: 'scope.org.policies.level', ne: 3 }, 'policies.level', '3.00');
          await lists(user('ann'), 'doc:edit', ALL);
          await put({ attr: 'scope.org.policies.locked', eq: true }, 'policies.locked', '1.0');
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
          // 2.9999999999999999 is the double 3, so lt 3 is FALSE in the check; Postgres reads the decimal, below 3. SQL
          // leaves texts that long undecided, and the restrict then refuses the rows it may drop.
          await put({ attr: 'scope.org.policies.level', lt: 3 }, 'policies.level', '2.9999999999999999');
          await narrower(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8'], ['1', '3']);
          await put({ attr: 'scope.org.policies.level', ne: 3 }, 'policies.level', '3.0000000000000001');
          await narrower(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8'], ['1', '3']);
          // The same text under eq: the check applies the restrict, which a decimal comparison would not.
          await put({ attr: 'scope.org.policies.level', eq: 3 }, 'policies.level', '3.0000000000000001');
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7', '8']);
        }
      });

      it("resource patterns of config and stored thresholds share the evaluator's work budget: a long name SQL cannot follow under it denies", async () => {
        const table = db.table(world.models.Doc);
        // Matches neither pattern; within the bound of one leaf (1e6 / 10 code points), beyond that of two.
        await db.raw(kind, `UPDATE "${table}" SET "name" = '${'zzz'.padEnd(60000, 'x')}' WHERE "id" = 5`);
        try {
          const t1: Rule = { id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer', resource: { attr: 'resource.name', wildcard: 'release/*' } };
          const t2: Rule = { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer', resource: { attr: 'resource.name', wildcard: 'notes*' } };
          const rows = [assignment(u('ann'), 'editor', GLOBAL)];
          await scenario([t1], rows);
          await lists(user('ann'), 'doc:edit', ['2', '4', '5', '6', '7']);
          await scenario([t1, t2], rows);
          await narrower(user('ann'), 'doc:edit', ['4', '6', '7'], ['5']);
          await scenario([t1], rows, [t2]);
          await narrower(user('ann'), 'doc:edit', ['4', '6', '7'], ['5']);
        } finally {
          await db.raw(kind, `UPDATE "${table}" SET "name" = 'release/' WHERE "id" = 5`);
        }
      });

      it('a definition the check reads otherwise than SQL refuses its path: JSON5, malformed text, a repeated key, a key spelled with an escape (review M1)', async () => {
        const rows = [assignment(u('ann'), 'editor', GLOBAL)];
        const text = (raw: RawRuleRow, definition: string): RawRuleRow => ({ ...raw, rule: { ...raw.rule, definition } });
        const strip = rawRule({ id: 'c1', kind: 'cap', scope: O('o2'), stripTags: true }, { kind: 'cap', stripTags: true });
        const clamp = rawRule({ id: 'c1', kind: 'cap', scope: O('o2'), ladder: 'project', maxRole: 'maintainer' }, { kind: 'cap', ladder: 'project', maxRole: 'maintainer' });
        // The check's JSON.parse throws, so the check refuses every row on the rule's path; Postgres fails the list.
        const unreadable = async () => {
          if (kind === 'sqlite') return void (await lists(user('ann'), 'doc:edit', ['1', '3', '5', '6', '7', '8']));
          expect(await world.allowed(user('ann'), 'doc:edit')).to.deep.equal(['1', '3', '5', '6', '7', '8']);
          const e = await world.listed(user('ann'), 'doc:edit').then(
            () => undefined,
            (err: unknown) => err,
          );
          expect(e, `${kind}: the list fails`).to.be.instanceOf(Error);
        };
        await scenario([], rows, [], [text(strip, '{"kind":"cap","stripTags":true,}')]);
        await unreadable();
        await scenario([], rows, [], [text(strip, '{bad')]);
        await unreadable();
        // JSON.parse and Postgres take the last of a repeated key (viewer), SQLite the first; JSON.parse and Postgres
        // read a key spelled with an escape, SQLite's json_extract does not. SQLite refuses the path.
        for (const definition of ['{"kind":"cap","ladder":"project","maxRole":"maintainer","maxRole":"viewer"}', '{"kind":"cap","ladder":"project","max\\u0052ole":"viewer"}']) {
          await scenario([], rows, [], [text(clamp, definition)]);
          await lists(user('ann'), 'doc:edit', ['1', '3', '5', '6', '7', '8']);
          if (kind === 'postgres') await lists(user('ann'), 'doc:read', ALL);
          else await narrower(user('ann'), 'doc:read', ['1', '3', '5', '6', '7', '8'], ['2', '4']);
        }
      });

      it('a definition rowToRule cannot use refuses its path: a top level that is no object, a non-array allow or subjects.refs, a NUL on SQLite (db re-review N1)', async () => {
        // editor at o2 is not above the restrict's node: a restrict the store reads keeps docs 2 and 4.
        const rows = [assignment(u('ann'), 'editor', O('o2')), assignment(u('ann'), 'editor', O('o1'))];
        const restrict = rawRule({ id: 'r1', kind: 'restrict', scope: O('o2'), allow: [] }, { kind: 'restrict', allow: [] });
        const text = (definition: string): RawRuleRow => ({ ...restrict, rule: { ...restrict.rule, definition } });
        await scenario([], rows, [], [text('{"kind":"restrict","allow":[]}')]);
        await lists(user('ann'), 'doc:edit', ['1', '2', '3', '4']);
        // rowToRule throws on these, so the check refuses every row on the rule's path.
        const thrown = ['null', '{"kind":"restrict","allow":5}', '{"kind":"restrict","allow":{}}', '{"kind":"restrict","allow":"ab"}', '{"kind":"restrict","allow":[],"subjects":{"refs":"x"}}', ...(kind === 'sqlite' ? ['{"kind":"restrict","allow":[]}\u0000x'] : [])];
        for (const definition of thrown) {
          await scenario([], rows, [], [text(definition)]);
          await lists(user('ann'), 'doc:edit', ['1', '3']);
        }
        // Read by rowToRule as an empty definition (the columns' restrict): refused here, narrower.
        for (const definition of ['[]', '"x"']) {
          await scenario([], rows, [], [text(definition)]);
          await narrower(user('ann'), 'doc:edit', ['1', '3'], ['2', '4']);
        }
        // A subjects value that is no object holds no refs for either side.
        await scenario([], rows, [], [text('{"kind":"restrict","allow":[],"subjects":5}')]);
        await lists(user('ann'), 'doc:edit', ['1', '2', '3', '4']);
      });

      it('a row comparing a number attribute with a numeric string literal is inexact: refused where its choice matters (review M2)', async () => {
        // o1's level is 3: not "2" in the check. toSqlForm refuses the literal; a row written past the store holds it.
        const rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', P('10'))];
        const cap: Rule = { id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'project', at: 'project', gte: 'editor' } } };
        const raw = rawRule({ id: 'r1', kind: 'restrict', scope: O('o1'), allow: [], when: { attr: 'scope.org.policies.level', eq: 'x' } }, { kind: 'restrict', allow: [], when: { attr: 'scope.org.policies.level', eq: '2' } });
        await scenario([cap], rows, [], [{ ...raw, rule: { ...raw.rule, when_value: JSON.stringify('2') } }]);
        await lists(user('ann'), 'doc:comment', ['4']);
      });

      it('ids outside the BMP: SQL takes no order from them, where UTF-16 code units (the check) and code points (SQL) differ (review M5)', async () => {
        const rows = [assignment(u('ann'), 'editor', GLOBAL), assignment(u('ann'), 'commenter', O('o2'))];
        const plain = (id: string): Rule => ({ id, kind: 'restrict', scope: O('o2'), allow: [] });
        const reading = (id: string): Rule => ({ id, kind: 'restrict', scope: O('o2'), allow: [], when: { attr: 'scope.project.tier', eq: 'gold' } });
        // Before 'r\uE000' in code units, after it in code points.
        const [astral, high] = ['r\u{10000}', 'r\uE000'];
        // The check runs the reading restrict first and throws at doc 4 (no project node); code points would put the plain one first.
        await scenario([reading(astral)], rows, [plain(high)]);
        await lists(user('ann'), 'doc:comment', ['1', '2', '3', '5', '6', '7', '8']);
        await scenario([plain(high)], rows, [reading(astral)]);
        await lists(user('ann'), 'doc:comment', ['1', '2', '3', '5', '6', '7', '8']);
        // The plain restrict first in the check: SQL cannot tell, and refuses doc 4.
        await scenario([plain(astral)], rows, [reading(high)]);
        await narrower(user('ann'), 'doc:comment', ['1', '2', '3', '5', '6', '7', '8'], ['4']);
      });

      it('the scenarios compiled stored-rule terms', () => {
        expect(terms.route, 'route terms').to.be.at.least(20);
        expect(terms.threshold, '{ db: true } terms').to.be.at.least(20);
      });
    });
  }
});
