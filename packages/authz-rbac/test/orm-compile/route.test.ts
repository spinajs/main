import { AuthzConfigError, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, Principal, ResourceFilter } from '@spinajs/authz';
import { fakeModelInitContext, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RbacModel, createRbacExtensions, parseRbacListArgs, rbacAssignmentArgsV2, rbacAssignmentExtension, rbacTables } from '../../src/index.js';
import type { RbacAssignmentArgsV2, RbacRoute } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource, rbacRoutePlan } from '../../src/orm/index.js';
import type { RbacListing } from '../../src/orm/index.js';
import { SQLITE_ODD_DOCS } from '../orm/orm-world.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { DAY, LADDERS, PERMISSIONS, ROLES, RouteWorld, SERVICE_ROLES, assignment, at, registerRouteSources, routeArgs, service, team, u, user } from './route-world.js';

const ALL = ['1', '2', '3', '4', '5', '6', '7', '8'];

async function standaloneListing(): Promise<RbacListing> {
  const reg = new PermissionRegistryImpl();
  reg.register(
    PERMISSIONS.map((name) => ({ name, types: ['doc'] })),
    'test',
  );
  reg.freeze();
  const options = { roles: new MemoryRoleStore(ROLES, LADDERS), assignments: new MemoryAssignmentStore() };
  const model = new RbacModel({ ...options, extensions: [...createRbacExtensions(options), rbacAssignmentExtension(options, { rules: true })], log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: reg, config: { serviceRoles: SERVICE_ROLES } }));
  const roles = model.roleGraph();
  const grants = model.grantIndex();
  return { roles, grants, ...rbacTables(model.extensions, roles, grants) };
}

const context = (extra: Partial<RbacAssignmentArgsV2> = {}): Omit<RbacAssignmentArgsV2, 'v' | 'route'> => ({ permission: 'doc:edit', subjects: [{ type: 'user', id: 'x' }], config: [], principal: { type: 'user', id: 'x' }, companions: [], rules: [], dbRules: false, ...extra });

const args = (permission: string, route: RbacRoute, extra: Partial<RbacAssignmentArgsV2> = {}): RbacAssignmentArgsV2 => rbacAssignmentArgsV2(context({ permission, ...extra }), route);

const ROUTES = {
  edit: { role: 'editor', grant: 0, ladder: 'project', roles: ['editor', 'lead.plus', 'maintainer', 'org.admin', 'org.owner', 'senior', 'team.lead'] },
  audit: { role: 'editor', grant: 1, ladder: 'project', grantedAt: ['$global', 'project'], roles: ['editor', 'lead.plus', 'maintainer', 'org.admin', 'org.owner', 'senior', 'team.lead'] },
  review: { role: 'maintainer', grant: 0, ladder: 'project', requiresTag: 'review', grantedAt: ['org', 'project'], roles: ['maintainer', 'org.admin', 'org.owner'] },
  exportAudit: { role: 'auditor', grant: 0, grantedAt: ['org'], roles: ['auditor'] },
  org: { role: 'org.guest', grant: 0, ladder: 'org', roles: ['org.admin', 'org.guest', 'org.owner'] },
  tagger: { role: 'tagger', grant: 0, requiresTag: 'a,b', roles: ['tagger'] },
} satisfies Record<string, RbacRoute>;

describe('authz-rbac orm-compile: grant routes (args v2 without rules)', function () {
  this.timeout(600000);

  describe('the plan', () => {
    let listing: RbacListing;

    before(async () => {
      listing = await standaloneListing();
    });

    it('a ladder grant: holders through the ladder and extends, implied roles at and below their scope', () => {
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit), 'doc')).to.deep.equal({
        applies: true,
        needs: [{ what: 'holder', config: false, direct: ['editor', 'maintainer', 'senior'], implied: ['org.owner', 'org.admin'], impliedBelow: ['team.lead', 'lead.plus'] }],
      });
    });

    it('requiresTag and grantedAt: stored and implied tags, provenance on the ladder at the grant rank; the holder folds into provenance', () => {
      const review = rbacRoutePlan(listing, args('doc:review', ROUTES.review), 'doc');
      expect(review.needs.map((n) => n.what)).to.deep.equal(['tag', 'provenance']);
      expect(review.needs[0]).to.deep.include({ config: false, implied: [], impliedBelow: ['team.lead', 'lead.plus'], storedTag: 'review' });
      expect(review.needs[0].direct).to.have.length(ROLES.length);
      expect(review.needs[1]).to.deep.equal({ what: 'provenance', config: false, direct: ['maintainer'], implied: ['org.owner', 'org.admin'], impliedBelow: [], madeAt: ['org', 'project'] });
    });

    it('grantedAt on a ladder counts roles of that ladder at the grant rank, not an off-ladder holder (senior)', () => {
      expect(rbacRoutePlan(listing, args('doc:audit', ROUTES.audit), 'doc').needs).to.deep.equal([{ what: 'provenance', config: false, direct: ['editor', 'maintainer'], implied: ['org.owner', 'org.admin'], impliedBelow: ['team.lead', 'lead.plus'], madeAt: ['$global', 'project'] }]);
    });

    it('grantedAt off a ladder counts holders made there; the ceiling filters stored and implied roles', () => {
      expect(rbacRoutePlan(listing, args('doc:export', ROUTES.exportAudit), 'doc').needs).to.deep.equal([{ what: 'provenance', config: false, direct: ['auditor'], implied: [], impliedBelow: [], madeAt: ['org'] }]);
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { ceilingRoles: ['team.lead', 'org.owner', 'maintainer'] }), 'doc').needs).to.deep.equal([{ what: 'holder', config: false, direct: ['maintainer'], implied: ['org.owner'], impliedBelow: [] }]);
    });

    it('config roles are GLOBAL constants: a role implied below GLOBAL holds on every row; not one the ceiling or the role definition refuses', () => {
      const robot = { subject: { type: 'service', id: 's1' }, role: 'team.lead' };
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { config: [robot] }), 'doc').needs[0].config).to.equal(true);
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { config: [robot], ceilingRoles: ['team.lead'] }), 'doc').needs[0].config).to.equal(false);
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { config: [robot], ceilingRoles: ['editor'] }), 'doc').needs[0].config).to.equal(false);
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { config: [{ ...robot, role: 'ghost' }] }), 'doc').needs[0].config).to.equal(false);
      expect(rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { config: [{ ...robot, role: 'org.owner' }] }), 'doc').needs[0].config).to.equal(false);
      // A config role has no tags, and provenance needs '$global' among the types.
      expect(rbacRoutePlan(listing, args('doc:review', ROUTES.review, { config: [{ ...robot, role: 'maintainer' }] }), 'doc').needs.map((n) => n.config)).to.deep.equal([false, false]);
      expect(rbacRoutePlan(listing, args('doc:audit', ROUTES.audit, { config: [{ ...robot, role: 'maintainer' }] }), 'doc').needs.map((n) => n.config)).to.deep.equal([true]);
    });

    it("a ladder's resourceTypes: the grant does not apply on the row type", () => {
      expect(rbacRoutePlan(listing, args('doc:org', ROUTES.org), 'doc').applies).to.equal(false);
      expect(rbacRoutePlan(listing, args('doc:org', ROUTES.org), 'project').applies).to.equal(true);
    });

    it("a requiresTag holding ',' is on no stored row: only implied entries could carry it", () => {
      expect(rbacRoutePlan(listing, args('doc:read', ROUTES.tagger), 'doc').needs).to.deep.equal([
        { what: 'holder', config: false, direct: ['tagger'], implied: [], impliedBelow: [] },
        { what: 'tag', config: false, direct: [], implied: [], impliedBelow: [], storedTag: 'a,b' },
      ]);
    });

    it('has no plan for args with rules (RbacRulesSql compiles them) or dbRules (the next task)', () => {
      const rule = { id: 'r', kind: 'restrict' as const, scope: { type: 'org', id: 'o1' } };
      expect(() => rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { rules: [rule] }), 'doc')).to.throw(AuthzConfigError, /RbacRulesSql/);
      expect(() => rbacRoutePlan(listing, args('doc:edit', ROUTES.edit, { dbRules: true }), 'doc')).to.throw(AuthzConfigError, /dbRules.*next L4b task/);
    });

    it('refuses a route the current roles do not give as stated', () => {
      const stale = (permission: string, route: RbacRoute) => expect(() => rbacRoutePlan(listing, args(permission, route), 'doc')).to.throw(AuthzConfigError, /roles changed/);
      stale('doc:edit', { ...ROUTES.edit, role: 'nobody' });
      stale('doc:edit', { ...ROUTES.edit, grant: 7 });
      stale('doc:read', ROUTES.edit);
      stale('doc:edit', { ...ROUTES.edit, ladder: 'org' });
      const { ladder: _ladder, ...offLadder } = ROUTES.edit;
      stale('doc:edit', offLadder);
      stale('doc:edit', { ...ROUTES.edit, roles: ['editor', 'maintainer'] });
      stale('doc:edit', { ...ROUTES.edit, requiresTag: 'review' });
      stale('doc:review', { ...ROUTES.review, grantedAt: ['org'] });
      const { grantedAt: _at, ...noProvenance } = ROUTES.review;
      stale('doc:review', noProvenance);
    });
  });

  describe('SQL through authz-orm', () => {
    let db: RootOrm;
    let undoSource: (() => void) | undefined;

    before(async function () {
      db = await RootOrm.open(this, 'l4b_route');
      await (await testHost.domains()).service('root');
      undoSource = registerRouteSources();
    });

    after(async () => {
      undoSource?.();
      DI.uncache(RbacRoleGraphSource);
      DI.uncache(RbacScopeAttributeSource);
      await db?.close();
    });

    for (const kind of KINDS) {
      describe(kind, () => {
        let world: RouteWorld;
        let v2Terms = 0;

        before(async () => {
          world = await RouteWorld.open(db, kind);
        });

        after(async () => {
          await world?.close();
        });

        /** B06 for `p`: the rows listed through authz-orm are the rows check() allows and those the in-memory list filter keeps, and equal `want`. */
        async function lists(p: Principal, permission: string, want: readonly string[], opts: { v2?: boolean } = {}): Promise<ResourceFilter> {
          const residual = await world.residual(p, permission);
          const v2 = routeArgs(residual).length;
          v2Terms += v2;
          if (opts.v2 !== undefined) expect(v2 > 0, `${kind} ${p.id} ${permission}: args v2 in ${JSON.stringify(residual)}`).to.equal(opts.v2);
          const allowed = await world.allowed(p, permission);
          expect(allowed, `${kind} ${p.id} ${permission}: check()`).to.deep.equal([...want].sort());
          expect(await world.listed(p, permission), `${kind} ${p.id} ${permission}: listed`).to.deep.equal(allowed);
          expect(await world.inMemory(residual, p), `${kind} ${p.id} ${permission}: in memory`).to.deep.equal(allowed);
          return residual;
        }

        const world1 = (rows: readonly Assignment[]) => world.assign(rows);

        it('implied descendants: below the holder scope, never at the row the role is assigned at', async () => {
          await world1([assignment(u('ann'), 'team.lead', at('project', '10')), assignment(u('ann'), 'team.lead', at('doc', '3')), assignment(u('kay'), 'team.lead', at('doc', '2')), assignment(u('kay'), 'team.lead', at('doc', '3')), assignment(u('kai'), 'team.lead', at('doc', '2')), assignment(u('kai'), 'team.lead', at('project', '10'))]);
          await lists(user('ann'), 'doc:edit', ['1', '2', '7'], { v2: true });
          await lists(user('ann'), 'doc:read', ['1', '2', '7'], { v2: true });
          await lists(user('ann'), 'doc:export', []);
          await lists(user('kay'), 'doc:edit', [], { v2: true });
          await lists(user('kai'), 'doc:edit', ['1', '2', '7'], { v2: true });
        });

        it('requiresTag: some live assignment on the path carries the tag, not necessarily the holder', async () => {
          await world1([assignment(u('bea'), 'viewer', at('org', 'o1')), assignment(u('bea'), 'commenter', at('project', '11'), { tags: ['inspect'] }), assignment(u('ben'), 'viewer', at('org', 'o1')), assignment(u('ben'), 'support', at('project', '10'), { tags: ['inspect', 'x'] })]);
          await lists(user('bea'), 'doc:inspect', ['3', '8'], { v2: true });
          // support's stored tags count on its own assignment; it implies viewer there.
          await lists(user('ben'), 'doc:inspect', ['1', '2', '7'], { v2: true });
        });

        it('implied tags and scope types: an org owner holds maintainer with the inspect tag below its org; one at a project is refused', async () => {
          await world1([assignment(u('cid'), 'org.owner', at('org', 'o1')), assignment(u('cid'), 'org.owner', at('project', '10')), assignment(u('cyd'), 'org.owner', at('org', 'o2'))]);
          await lists(user('cid'), 'doc:inspect', ['1', '3'], { v2: true });
          await lists(user('cid'), 'doc:review', [], { v2: true });
          // The org ladder's grants do not apply on docs.
          await lists(user('cid'), 'doc:org', []);
          await lists(user('cyd', ['org.owner']), 'doc:inspect', []);
        });

        it('grantedAt on a ladder: an assignment made at those types with the grant rank, beside any holder', async () => {
          await world1([assignment(u('dan'), 'editor', at('org', 'o2')), assignment(u('dan'), 'maintainer', at('project', '11')), assignment(u('dan'), 'viewer', GLOBAL), assignment(u('dot'), 'editor', GLOBAL), assignment(u('dot'), 'viewer', at('project', '12')), assignment(u('sam'), 'senior', at('project', '10')), assignment(u('sam'), 'maintainer', at('project', '11'))]);
          await lists(user('dan'), 'doc:audit', ['3', '8'], { v2: true });
          // senior holds editor through extends, but has no rank on the ladder: no provenance at project 10.
          await lists(user('sam'), 'doc:audit', ['3', '8'], { v2: true });
          await lists(user('sam'), 'doc:edit', ['1', '2', '3', '7', '8']);
          // Made at GLOBAL with the rank: every row.
          await lists(user('dot'), 'doc:audit', ALL);
        });

        it('grantedAt off a ladder: a holder of the grant made at those types', async () => {
          await world1([assignment(u('eve'), 'auditor', at('org', 'o1')), assignment(u('eve'), 'auditor', at('project', '10')), assignment(u('eve'), 'lead.plus', at('project', '12')), assignment(u('eli'), 'auditor', at('project', '10'))]);
          await lists(user('eve'), 'doc:export', ['1', '3', '5'], { v2: true });
          await lists(user('eli'), 'doc:export', [], {});
          await lists(user('eve'), 'doc:comment', ['1', '2', '3', '5', '7'], { v2: true });
        });

        it('config roles are GLOBAL constants: implied below GLOBAL on every row, with their tags', async () => {
          const s1 = { type: 'service', id: 's1' };
          await world1([assignment(s1, 'team.lead', at('project', '13'))]);
          await lists(service(), 'doc:inspect', ALL);
          await lists(service(), 'doc:edit', ['6'], { v2: true });
          await lists(service(), 'doc:comment', ALL);
        });

        it('the ceiling keeps stored roles and implied roles that it lists, each on its own', async () => {
          await world1([assignment(u('fay'), 'team.lead', at('project', '10')), assignment(u('fay'), 'viewer', at('org', 'o2'), { tags: ['inspect'] }), assignment(u('fay'), 'editor', GLOBAL), assignment(u('fay'), 'org.owner', at('org', 'o1'))]);
          const fay = user('fay', ['viewer', 'team.lead', 'org.owner']);
          await lists(fay, 'doc:edit', []);
          await lists(fay, 'doc:inspect', ['2', '4'], { v2: true });
          await lists(user('fay', ['team.lead', 'editor']), 'doc:edit', ALL);
          await lists(user('fay'), 'doc:inspect', ['1', '2', '3', '4'], { v2: true });
        });

        it('subject sets: an assignment of a set holds while a membership does', async () => {
          await world1([assignment(u('gus'), 'team.member', at('team', 't1')), assignment(team('t1'), 'team.lead', at('project', '11')), assignment(u('hal'), 'team.member', at('team', 't2'), { expiresAt: new Date(Date.now() - DAY) }), assignment(team('t2'), 'team.lead', at('project', '10'))]);
          await lists(user('gus'), 'doc:edit', ['3', '8'], { v2: true });
          await lists(user('hal'), 'doc:edit', []);
          // A ceiling without the membership role leaves the set out.
          await lists(user('gus', ['team.lead']), 'doc:edit', []);
        });

        it('expired, unassignable and wrong-scope assignments count for nothing; NULL and empty ancestors name no node', async () => {
          await world1([assignment(u('ivy'), 'team.lead', at('project', '10'), { expiresAt: new Date(Date.now() - DAY) }), assignment(u('ivy'), 'ghost', GLOBAL), assignment(u('ivy'), 'projectOnly', at('org', 'o1')), assignment(u('ivy'), 'projectOnly', at('project', '11')), assignment(u('ivy'), 'team.lead', at('project', '12'), { expiresAt: new Date(Date.now() + DAY) }), assignment(u('jo'), 'team.lead', at('org', 'o1')), assignment(u('jo'), 'team.lead', at('org', 'O1'))]);
          await lists(user('ivy'), 'doc:edit', ['3', '5', '8'], { v2: true });
          await lists(user('ivy'), 'doc:read', ['5'], { v2: true });
          await lists(user('jo'), 'doc:edit', ['1', '3', '7'], { v2: true });
        });

        it("a requiresTag holding ',': stored tags ',a,b,' do not carry 'a,b'", async () => {
          await world1([assignment(u('zed'), 'tagger', GLOBAL, { tags: ['a', 'b'] }), assignment(u('zed'), 'team.lead', at('doc', '2'))]);
          const residual = await lists(user('zed'), 'doc:read', [], { v2: true });
          expect(routeArgs(residual).map((a) => (a.route as { role: string }).role)).to.include('tagger');
        });

        it('hand-built args: config roles, a ceiling and a grant that does not apply here, against the in-memory evaluator; the request principal is not read', async () => {
          // ann's org.guest grants doc:org, but the org ladder's grants do not apply on docs.
          await world1([assignment(u('ann'), 'team.lead', at('project', '10')), assignment(u('ann'), 'org.guest', GLOBAL)]);
          const residual = await world.residual(user('ann'), 'doc:edit');
          const [real] = routeArgs(residual) as unknown as RbacAssignmentArgsV2[];
          const { v: _v, route, ...ctx } = parseRbacListArgs(RBAC_ASSIGNMENT_OP, real);
          const cases: [RbacAssignmentArgsV2, string[]][] = [
            [real, ['1', '2', '7']],
            [rbacAssignmentArgsV2({ ...ctx, config: [{ subject: { type: 'service', id: 'z' }, role: 'team.lead' }] }, route), ALL],
            [rbacAssignmentArgsV2({ ...ctx, ceilingRoles: ['viewer'] }, route), []],
            // The ceiling keeps the implied editor but not the config role implying it.
            [rbacAssignmentArgsV2({ ...ctx, config: [{ subject: { type: 'service', id: 'z' }, role: 'team.lead' }], ceilingRoles: ['editor'] }, route), []],
            [rbacAssignmentArgsV2({ ...ctx, subjects: [] }, route), []],
            [rbacAssignmentArgsV2({ ...ctx, permission: 'doc:org' }, ROUTES.org), []],
          ];
          for (const [a, want] of cases) {
            const term: ResourceFilter = { op: RBAC_ASSIGNMENT_OP, args: a } as unknown as ResourceFilter;
            expect(await world.compiled(term, user('ann')), `${kind} ${JSON.stringify(a)}`).to.deep.equal(want);
            // E3: the compiler takes the principal from the args only.
            expect(await world.compiled(term, user('nobody')), `${kind} another principal ${JSON.stringify(a)}`).to.deep.equal(want);
            expect(await world.inMemory(term, user('ann')), `${kind} in memory ${JSON.stringify(a)}`).to.deep.equal(want);
          }
        });

        if (kind === 'sqlite') {
          it('a row the adapter cannot find, or by an id SQL cannot print, is UNKNOWN: neither the term nor its NOT lists it', async () => {
            await world1([assignment(u('ann'), 'team.lead', at('project', '10'))]);
            const [real] = routeArgs(await world.residual(user('ann'), 'doc:edit')) as unknown as RbacAssignmentArgsV2[];
            const { v: _v, route, ...ctx } = parseRbacListArgs(RBAC_ASSIGNMENT_OP, real);
            await db.insert(world.models.Doc, SQLITE_ODD_DOCS);
            try {
              for (const a of [real, rbacAssignmentArgsV2({ ...ctx, config: [{ subject: { type: 'service', id: 'z' }, role: 'team.lead' }] }, route)]) {
                const term = { op: RBAC_ASSIGNMENT_OP, args: a } as unknown as ResourceFilter;
                const yes = await world.compiled(term, user('ann'));
                const no = await world.compiled({ op: 'not', arg: term }, user('ann'));
                // check() decides doc 9.5; SQL names no node by a non-integer number id (narrower, task "orm").
                expect(yes, `${JSON.stringify(a)}`).to.deep.equal((await world.inMemory(term, user('ann'))).filter((id) => id !== '9.5'));
                expect([...yes, ...no].sort()).to.deep.equal((await world.docIds()).filter((id) => id !== '9.5' && id !== 'x9'));
              }
            } finally {
              await db.raw(kind, `DELETE FROM "${db.table(world.models.Doc)}" WHERE "id" IN ('x9', 9.5, 20)`);
            }
          });
        }

        it('refuses args v2 with dbRules, a stale route, and a source without the listing', async () => {
          await world1([assignment(u('ann'), 'team.lead', at('project', '10'))]);
          const [real] = routeArgs(await world.residual(user('ann'), 'doc:edit')) as unknown as RbacAssignmentArgsV2[];
          const { v: _v, route, ...ctx } = parseRbacListArgs(RBAC_ASSIGNMENT_OP, real);
          const compile = (a: unknown) => world.compiled({ op: RBAC_ASSIGNMENT_OP, args: a } as unknown as ResourceFilter, user('ann'));
          const refused = async (a: unknown, why: RegExp) => {
            const e = await compile(a).then(
              () => undefined,
              (err: unknown) => err,
            );
            expect(e, String(why)).to.be.instanceOf(AuthzConfigError);
            expect((e as Error).message).to.match(why);
          };
          await refused(rbacAssignmentArgsV2({ ...ctx, dbRules: true }, route), /dbRules.*next L4b task/);
          await refused(rbacAssignmentArgsV2(ctx, { ...route, grant: 3 }), /roles changed/);
          await refused({ ...real, extra: 1 }, /unknown args key/);
          const undo = testHost.registerInRoot(
            RbacRoleGraphSource,
            testHost.instance(
              new (class extends RbacRoleGraphSource {
                graph() {
                  return world.model.roleGraph();
                }
              })(),
            ),
          );
          DI.uncache(RbacRoleGraphSource);
          try {
            await refused(real, /listing/);
          } finally {
            undo();
            DI.uncache(RbacRoleGraphSource);
          }
          expect(await compile(real)).to.deep.equal(['1', '2', '7']);
        });

        it('the scenarios ran args v2 terms', () => {
          expect(v2Terms).to.be.at.least(15);
        });
      });
    }
  });
});
