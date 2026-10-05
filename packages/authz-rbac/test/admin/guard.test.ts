import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AuthzConfigError, PermissionRegistry, SYSTEM, TRUE, compilePermissionGlob, resourceKey } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, AuthzCommandResult, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { CheckRbacAdminFacts, DefaultAdminGuard, RbacAdminFacts } from '../../src/index.js';
import type { Assignment, AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { G, GR, HOUR, O1, P1, START, StaticRoleStore, config, failure, installHost, instance, ok, permissionRegistry, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain, RbacDomainOptions } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
const grants = (...names: string[]) => names.map((permission) => ({ permission }));
const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

export const GUARD_ROLES: RoleDef[] = [role('viewer', { ladder: 'project', grants: grants('file:read') }), role('editor', { ladder: 'project', grants: grants('file:edit') }), role('maintainer', { ladder: 'project', grants: grants('project:settings') }), role('helper', { ladder: 'staff', grants: grants('users:read') }), role('admin', { ladder: 'staff', grants: grants('users:update', 'authz:assignments.manage') }), role('ops', { grants: grants('authz:assignments.manage') }), role('manager', { grants: grants(...MANAGE) }), role('globber', { grants: grants('file:*') }), role('reader', { extends: ['viewer'] }), role('sys', { assignable: false, grants: grants('users:update') }), role('package', { assignable: false, grants: grants('file:read') }), role('group.member', { subjectSet: true, scopeTypes: ['group'] }), role('staff.set', { subjectSet: true }), role('lead', { implies: [{ role: 'maintainer', at: 'self-and-descendants' }] }), role('boss', { implies: [{ role: 'admin', at: 'self-and-descendants' }] }), role('far', { implies: [{ role: 'admin', at: 'descendants' }] }), role('skipper', { implies: [{ role: 'viewer', at: 'self-and-descendants', bypass: ['restrict'] }] })];
export const GUARD_LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'staff', roles: ['helper', 'admin'] },
];

const user = (id: string): PrincipalRef => ({ type: 'user', id });
const row = (id: string, subject: AssignmentSubject, r: string, scope: ResourceRef = G, extra: Partial<Assignment> = {}): Assignment => ({ id, subject, role: r, scope, tags: [], expiresAt: null, source: 'test', ...extra });
const admins = (...ids: string[]) => ids.map((i) => row(`a-${i}`, user(i), 'admin'));
const BASE: Assignment[] = [row('b1', user('bob'), 'editor', P1), row('b2', user('bob'), 'manager', P1), row('o1', user('ops'), 'ops')];
const STAFF: AssignmentSubject = { set: { role: 'staff.set', scope: G } };
const GROUP: AssignmentSubject = { set: { role: 'group.member', scope: GR } };

// No types: checked anywhere but at GLOBAL or a 'users' resource, they throw.
const USER_PERMISSIONS = { 'users:update': {}, 'users:read': {} };

const GUARD = { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true };

interface Standing {
  readonly allow?: readonly string[];
  readonly conditional?: readonly string[];
  readonly roles?: Readonly<Record<string, string>>;
}

/** Decisions by principal id and resource ('*': anywhere); the guard's view of the actor comes only from here. */
class Table {
  private readonly rows = new Map<string, Standing>();

  set(id: string, at: ResourceRef | '*', s: Standing): void {
    this.rows.set(`${id}@${at === '*' ? '*' : resourceKey(at)}`, s);
  }

  model(): StaticModel {
    return new StaticModel({
      name: 'table',
      votes: (req) => {
        const s = this.rows.get(`${req.principal.id}@${resourceKey(req.resource)}`) ?? this.rows.get(`${req.principal.id}@*`);
        if (!s) return {};
        const has = (globs: readonly string[] = []) => globs.some((g) => compilePermissionGlob(g)(req.permission));
        const vote = has(s.allow) ? { permitWhen: TRUE } : has(s.conditional) ? { permitWhen: { op: 'cmp' as const, field: 'owner', cmp: 'eq' as const, value: req.principal.id } } : {};
        return { ...vote, ...(s.roles ? { roles: s.roles } : {}) };
      },
    });
  }
}

const p = userPrincipal;
const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });
const grant = (r: string, scope: ResourceRef = P1, subject: AssignmentSubject = user('alice'), extra: Partial<Extract<AuthzCommand, { kind: 'assignment.grant' }>> = {}): AuthzCommand => ({ kind: 'assignment.grant', subject, role: r, scope, ...extra });
const at = (ms: number) => new Date(START.getTime() + ms);

describe('DefaultAdminGuard', function () {
  this.timeout(20000);
  let table: Table;
  let d: RbacDomain;

  interface WorldOptions {
    readonly rows?: readonly Assignment[];
    readonly guard?: Record<string, unknown>;
    readonly links?: RbacDomainOptions['links'];
    readonly register?: RbacDomainOptions['register'];
    readonly roles?: readonly RoleDef[];
    readonly ladders?: readonly LadderDef[];
    readonly permissions?: RbacDomainOptions['permissions'];
    /** false: no PermissionRegistry in the container (the table model exposes none either). */
    readonly registry?: boolean;
  }

  async function world(opts: WorldOptions = {}): Promise<RbacDomain> {
    await resetHost();
    const permissions = { ...USER_PERMISSIONS, ...opts.permissions };
    d = await rbacDomain('test', {
      roleStores: [new StaticRoleStore('guard', opts.roles ?? GUARD_ROLES, opts.ladders ?? GUARD_LADDERS)],
      assignments: opts.rows ?? [...BASE, ...admins('root', 'root2')],
      links: opts.links,
      admin: { backend: 'TestBackend', guard: opts.guard ?? GUARD },
      model: table.model(),
      permissions,
      register: (c) => {
        if (opts.registry !== false) c.register(instance(permissionRegistry(permissions))).as(PermissionRegistry);
        opts.register?.(c);
      },
    });
    return d;
  }

  const run = (actor: Principal, commands: AuthzCommand[]) => d.admin.execute(actor, commands);
  const refused = async (actor: Principal, commands: AuthzCommand[], code: string, index = commands.length - 1): Promise<void> => {
    const f = failure(await run(actor, commands));
    expect({ at: f.at, code: f.code }).to.deep.equal({ at: index, code });
  };
  const passes = async (actor: Principal, commands: AuthzCommand[]): Promise<readonly AuthzCommandResult[]> => ok(await run(actor, commands));
  const exists = async (id: string) => (await d.assignments.byId(id)) !== null;

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    table = new Table();
    const top = { allow: ['*'], roles: { project: 'maintainer', staff: 'admin' } };
    for (const id of ['root', 'root2', 'super']) table.set(id, '*', top);
    // The staff rank lets ops remove admin rows, so the removal cases reach self_lockout and last_holder.
    table.set('ops', '*', { allow: ['authz:assignments.manage'], roles: { staff: 'admin' } });
    table.set('bob', P1, { allow: ['file:read', 'file:edit', 'authz:*.manage'], roles: { project: 'editor' } });
    table.set('bob', GR, { allow: ['authz:assignments.manage'] });
    table.set('carol', P1, { allow: ['authz:assignments.manage'], conditional: ['file:read', 'file:edit'], roles: { project: 'editor' } });
    table.set('dan', P1, { allow: ['file:read', 'file:edit', 'project:settings', 'authz:assignments.manage'], roles: { project: 'editor' } });
    table.set('dan2', P1, { allow: ['file:read', 'authz:assignments.manage'] });
    table.set('erin', P1, { allow: ['file:*', 'authz:assignments.manage'], roles: { project: 'maintainer' } });
    await world();
  });

  describe('wiring and configuration', () => {
    it('is registered under its class name, with CheckRbacAdminFacts behind RbacAdminFacts', async () => {
      expect(await d.container.resolve(RbacAdminFacts)).to.be.instanceOf(CheckRbacAdminFacts);
      await refused(p('ops'), [revoke('a-root'), revoke('a-root2')], 'last_holder');
    });

    it('reads authz.admin.guard per call', async () => {
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
      config().set(['authz', 'admin', 'guard'], { ...GUARD, preventSelfLockout: false });
      await passes(p('root'), [revoke('a-root')]);
    });

    it('a missing or malformed privilegedPermission rejects the call; with both checks that need it off it is not needed', async () => {
      const { privilegedPermission: _, ...noPrivileged } = GUARD;
      await world({ guard: noPrivileged });
      const e = await rejection(run(p('ops'), [revoke('a-root2')]));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.include('authz.admin.guard.privilegedPermission');
      await world({ guard: { ...GUARD, privilegedPermission: 'users' } });
      expect(await rejection(run(p('ops'), [revoke('a-root2')]))).to.be.instanceOf(AuthzConfigError);
      await world({ guard: { ...noPrivileged, preventSelfLockout: false, preventLastPrivilegedRemoval: false } });
      await passes(p('ops'), [revoke('a-root'), revoke('a-root2')]);
    });

    it('a switch that is not a boolean rejects the call; an absent switch is on', async () => {
      await world({ guard: { ...GUARD, preventEscalation: 'no' } });
      const e = await rejection(run(p('bob'), [grant('viewer')]));
      expect(e).to.be.instanceOf(AuthzConfigError);
      expect(e.message).to.include('authz.admin.guard.preventEscalation');
      await world({ guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update' } });
      await refused(p('bob'), [grant('maintainer')], 'escalation');
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
      await refused(p('ops'), [revoke('a-root'), revoke('a-root2')], 'last_holder');
      await world({ rows: [...BASE, ...admins('root'), row('s1', user('dave'), 'sys', P1)], guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update' } });
      await refused(p('ops'), [revoke('s1')], 'protected_role');
    });

    it('lets kinds it does not guard through without reading anything, and passes unknown kinds to the handler', async () => {
      const guard = new DefaultAdminGuard();
      const bare = await rbacDomainWithoutRoles();
      const ctx: AdminCallContext = { domain: 'bare', now: START, authz: bare.service, actor: p('bob'), container: bare.container, dryRun: false };
      for (const c of [{ kind: 'policy.put', policy: { id: 'x', effect: 'deny', permissions: ['file:read'] } }, { kind: 'policy.delete', id: 'x' }, { kind: 'scope.setAttributes', scope: P1, patch: {} }, { kind: 'scope.replaceAttributes', scope: P1, attributes: {} }, { kind: 'scope.forget', scope: P1 }, { kind: 'rule.delete', id: 'r' }, { kind: 'no.such.kind' }] as unknown as AuthzCommand[]) {
        await guard.check(p('bob'), c, ctx);
      }
      expect(await rejection(guard.check(p('bob'), grant('viewer'), ctx))).to.be.instanceOf(AuthzConfigError);
    });

    it('asks the RbacAdminFacts the domain registers', async () => {
      class Everything extends RbacAdminFacts {
        async covers(): Promise<boolean> {
          return true;
        }
        async effectiveRole(_a: Principal, ladder: string): Promise<string | undefined> {
          return ladder === 'staff' ? 'admin' : 'maintainer';
        }
      }
      await world({ register: (c) => c.register(Everything).as(RbacAdminFacts) });
      await passes(p('bob'), [grant('admin')]);
      await passes(p('bob'), [grant('maintainer')]);
    });
  });

  describe('escalation', () => {
    it('the actor must cover the role it grants', async () => {
      await refused(p('bob'), [grant('admin')], 'escalation');
      await passes(p('bob'), [grant('manager')]);
    });

    it("a ladder role may be granted up to the actor's own rank at the scope", async () => {
      await refused(p('bob'), [grant('maintainer')], 'escalation');
      await passes(p('bob'), [grant('editor')]);
      await passes(p('bob'), [grant('viewer', P1, user('root'))]);
      // dan holds every permission of maintainer but ranks editor; dan2 holds viewer's but no rank.
      await refused(p('dan'), [grant('maintainer')], 'escalation');
      await passes(p('dan'), [grant('editor')]);
      await refused(p('dan2'), [grant('viewer')], 'escalation');
    });

    it('a conditional allow does not cover', async () => {
      await refused(p('carol'), [grant('viewer')], 'escalation');
    });

    describe('glob grants are covered against the permission registry', () => {
      // note:own implies project:settings; nora holds note:* but not project:settings.
      const GLOB_ROLES = [...GUARD_ROLES, role('pglob', { grants: grants('project:*') }), role('nomatch', { grants: grants('nothing:*') }), role('badglob', { grants: grants('file:**') }), role('nglob', { grants: grants('note:*') }), role('nown', { grants: grants('note:own') }), role('nghost', { grants: grants('note:ghost') })];
      const globs = (opts: WorldOptions = {}) => world({ roles: GLOB_ROLES, permissions: { 'note:own': { types: ['project'], implies: ['project:settings'] }, 'note:read': { types: ['project'] } }, ...opts });

      beforeEach(() => {
        table.set('nora', P1, { allow: ['note:*', 'authz:assignments.manage'] });
      });

      it('a glob matching registered permissions the actor holds is covered', async () => {
        await globs();
        await passes(p('erin'), [grant('globber')]);
        await passes(p('erin'), [grant('viewer')]);
      });

      it('a glob matching a permission the actor lacks is refused', async () => {
        await globs();
        await refused(p('erin'), [grant('pglob')], 'escalation');
        await passes(p('root'), [grant('pglob')]);
      });

      it('a glob matching no registered permission, or an invalid glob, is refused', async () => {
        await globs();
        await refused(p('root'), [grant('nomatch')], 'escalation');
        await refused(p('root'), [grant('badglob')], 'escalation');
      });

      it('the permissions a grant matches bring in what they imply, glob or literal', async () => {
        await globs();
        await refused(p('nora'), [grant('nglob')], 'escalation');
        await refused(p('nora'), [grant('nown')], 'escalation');
        await passes(p('root'), [grant('nglob')]);
        await passes(p('root'), [grant('nown')]);
      });

      it('a literal grant of a permission the registry does not hold is refused', async () => {
        await globs();
        await refused(p('root'), [grant('nghost')], 'escalation');
      });

      it('with no registry every grant is refused, glob or literal, as the holder checks reject', async () => {
        await globs({ registry: false });
        await refused(p('erin'), [grant('globber')], 'escalation');
        await refused(p('erin'), [grant('viewer')], 'escalation');
        await refused(p('root'), [grant('viewer')], 'escalation');
      });
    });

    it('a permission checked outside its types counts as not covered', async () => {
      // helper grants users:read, whose types do not include project: the check throws.
      await refused(p('root'), [grant('helper')], 'escalation');
      await passes(p('root'), [grant('helper', G)]);
    });

    it('the closure includes extended roles', async () => {
      await refused(p('ops'), [grant('reader', P1)], 'escalation');
      await passes(p('bob'), [grant('reader')]);
    });

    it('set.addMember: the set role at the set scope and every role the set holds', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('g-ed', GROUP, 'editor', P1)] });
      await passes(p('bob'), [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: user('dave') }]);
      await world({ rows: [...BASE, ...admins('root'), row('g-mt', GROUP, 'maintainer', P1)] });
      await refused(p('bob'), [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: user('dave') }], 'escalation');
      await refused(p('bob'), [grant('group.member', GR, user('dave'))], 'escalation');
      await passes(SYSTEM, [{ kind: 'set.addMember', set: { role: 'group.member', scope: GR }, member: user('dave') }]);
    });

    it('links: a link may not grant a role above the actor', async () => {
      await refused(p('bob'), [{ kind: 'link.create', scope: P1, role: 'maintainer' }], 'escalation');
      const [created] = await passes(p('bob'), [{ kind: 'link.create', scope: P1, role: 'viewer' }]);
      await refused(p('bob'), [{ kind: 'link.update', id: created.ok ? created.id! : '', role: 'maintainer' }], 'escalation');
      await passes(p('bob'), [{ kind: 'link.update', id: created.ok ? created.id! : '', tags: ['x'] }]);
    });

    it('links: a link holding a subject set role reaches every role the set holds', async () => {
      table.set('bob', GR, { allow: ['authz:assignments.manage', 'authz:links.manage'] });
      const links = [
        { link: { id: 'l-st', scope: GR, attributes: {} }, token: 'tok-st', role: 'staff.set' },
        { link: { id: 'l-gm', scope: GR, attributes: {}, expiresAt: at(-HOUR) }, token: 'tok-gm', role: 'group.member' },
      ];
      await world({ rows: [...BASE, ...admins('root'), row('g-mt', GROUP, 'maintainer', P1)], links });
      await refused(p('bob'), [{ kind: 'link.create', scope: GR, role: 'group.member' }], 'escalation');
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-st', role: 'group.member' }], 'escalation');
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-gm', expiresAt: null }], 'escalation');
      await world({ rows: [...BASE, ...admins('root'), row('g-ed', GROUP, 'editor', P1)], links });
      await passes(p('bob'), [{ kind: 'link.create', scope: GR, role: 'group.member' }]);
      await passes(p('bob'), [{ kind: 'link.update', id: 'l-st', role: 'group.member' }]);
      await passes(p('bob'), [{ kind: 'link.update', id: 'l-gm', expiresAt: null }]);
    });

    it('implied roles: covers follows implies, and a ladder role a grant gives through implies needs the rank', async () => {
      await refused(p('bob'), [grant('lead')], 'escalation');
      // dan holds every permission of maintainer but ranks editor.
      await refused(p('dan'), [grant('lead')], 'escalation');
      await passes(p('root'), [grant('lead')]);
      await refused(p('ops'), [grant('boss', G)], 'escalation');
      // Holds every permission of boss and admin, but has no staff rank.
      table.set('unranked', '*', { allow: ['users:update', 'authz:assignments.manage'] });
      await refused(p('unranked'), [grant('boss', G)], 'escalation');
      await passes(p('root'), [grant('boss', G)]);
      // An implied role that bypasses restrict or cap rules cannot be judged from the actor's checks.
      await refused(p('root'), [grant('skipper')], 'escalation');
    });

    describe('canvas-shaped org roles (design §8.5)', () => {
      const ORG = ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'];
      const CANVAS_ROLES: RoleDef[] = [role('viewer', { ladder: 'project', grants: grants('file:read') }), role('commenter', { ladder: 'project' }), role('editor', { ladder: 'project', grants: grants('file:edit') }), role('maintainer', { ladder: 'project', grants: grants('project:settings') }), role('org.file_guest', { ladder: 'org' }), role('org.guest', { ladder: 'org' }), role('org.member', { ladder: 'org', subjectSet: true }), role('org.admin', { ladder: 'org', grants: grants('org:manage', 'audit:read'), implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect', 'code'], bypass: ['restrict', 'cap'] }] }), role('org.owner', { ladder: 'org', grants: grants('org:billing') })];
      const CANVAS_LADDERS: LadderDef[] = [
        { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
        { name: 'org', roles: ORG },
      ];
      const ORG_PERMISSIONS = { 'org:manage': { types: ['org'] }, 'audit:read': { types: ['org'] }, 'org:billing': { types: ['org'] } };
      const canvas = (register?: RbacDomainOptions['register']) => world({ roles: CANVAS_ROLES, ladders: CANVAS_LADDERS, permissions: ORG_PERMISSIONS, rows: [row('m-alice', user('alice'), 'org.member', O1)], register });
      const promote = (r = 'org.admin'): AuthzCommand => grant(r, O1, user('alice'), { replaceLadder: true });
      const ORG_POWERS = ['org:manage', 'audit:read', 'authz:assignments.manage'];

      beforeEach(() => {
        table.set('owner', O1, { allow: [...ORG_POWERS, 'org:billing'], roles: { org: 'org.owner' } });
        table.set('oadmin', O1, { allow: ORG_POWERS, roles: { org: 'org.admin' } });
        // Holds org.admin's literal permissions, but ranks member.
        table.set('member', O1, { allow: ORG_POWERS, roles: { org: 'org.member' } });
      });

      it('an org owner or admin grants org.admin at the org; an org member is refused', async () => {
        await canvas();
        await refused(p('member'), [promote()], 'escalation');
        await passes(p('owner'), [promote()]);
        expect((await d.assignments.find({ scope: O1, subject: user('alice'), at: START })).items.map((a) => a.role)).to.deep.equal(['org.admin']);
        await canvas();
        await passes(p('oadmin'), [promote()]);
        await canvas();
        await refused(p('oadmin'), [promote('org.owner')], 'escalation');
      });

      it('the rank check never asks for a ladder that does not apply at the scope, and refuses what it cannot skip', async () => {
        const asked: string[] = [];
        let orgRank = 'org.member';
        class Recording extends RbacAdminFacts {
          async covers(): Promise<boolean> {
            return true;
          }
          async effectiveRole(_a: Principal, ladder: string, scope: ResourceRef): Promise<string | undefined> {
            asked.push(`${ladder}@${resourceKey(scope)}`);
            return ladder === 'org' ? orgRank : 'maintainer';
          }
        }
        await canvas((c) => c.register(Recording).as(RbacAdminFacts));
        // org.admin above a member: its implied maintainer is followed, and the project ladder gives no rank at an org.
        await refused(p('member'), [promote()], 'escalation');
        orgRank = 'org.owner';
        await passes(p('owner'), [promote()]);
        expect(asked.filter((a) => a.startsWith('project@'))).to.deep.equal([]);
      });

      it('revoking or re-tagging org.admin skips its implied maintainer for an actor ranking org.admin or above', async () => {
        await canvas();
        await passes(p('owner'), [promote()]);
        const [granted] = (await d.assignments.find({ scope: O1, subject: user('alice'), role: 'org.admin', at: START })).items;
        await refused(p('member'), [revoke(granted.id)], 'escalation');
        await passes(p('oadmin'), [{ kind: 'assignment.setTags', id: granted.id, tags: [] }]);
        await passes(p('owner'), [revoke(granted.id)]);
      });
    });

    it('links: adding tags to a link checks its role', async () => {
      await world({
        links: [
          { link: { id: 'l-mt', scope: P1, attributes: {} }, token: 'tok', role: 'maintainer' },
          { link: { id: 'l-ed', scope: P1, attributes: {} }, token: 'tok-ed', role: 'editor', tags: ['keep'] },
        ],
      });
      expect(failure(await run(p('bob'), [{ kind: 'link.update', id: 'l-mt', tags: ['x'] }]))).to.deep.equal({ at: 0, code: 'escalation', field: 'tags' });
      await passes(p('bob'), [{ kind: 'link.update', id: 'l-mt', attributes: { org_only: true } }]);
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-mt', tags: [] }], 'escalation');
      await passes(p('bob'), [{ kind: 'link.update', id: 'l-ed', tags: [] }]);
    });

    it('tags: adding a tag checks the row role; removing one checks only its rank', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('d-mt', user('dave'), 'maintainer', P1, { tags: ['keep'] }), row('d-ed', user('dave'), 'editor', P1, { tags: ['keep'] })] });
      expect(failure(await run(p('bob'), [{ kind: 'assignment.addTags', id: 'd-mt', tags: ['x'] }]))).to.deep.equal({ at: 0, code: 'escalation', field: 'tags' });
      expect(failure(await run(p('bob'), [{ kind: 'assignment.setTags', id: 'd-mt', tags: ['keep', 'x'] }]))).to.deep.equal({ at: 0, code: 'escalation', field: 'tags' });
      expect(failure(await run(p('bob'), [{ kind: 'assignment.removeTags', id: 'd-mt', tags: ['keep'] }]))).to.deep.equal({ at: 0, code: 'escalation', field: 'id' });
      await passes(p('bob'), [{ kind: 'assignment.addTags', id: 'd-ed', tags: ['keep'] }]);
      // carol ranks editor but does not cover it: removal asks for no covers, adding does.
      await refused(p('carol'), [{ kind: 'assignment.addTags', id: 'd-ed', tags: ['x'] }], 'escalation');
      await passes(p('carol'), [{ kind: 'assignment.removeTags', id: 'd-ed', tags: ['keep'] }]);
      expect((await d.assignments.byId('d-ed'))!.tags).to.deep.equal([]);
      await passes(p('bob'), [{ kind: 'assignment.setTags', id: 'd-ed', tags: [] }]);
      await passes(p('bob'), [{ kind: 'assignment.addTags', id: 'b1', tags: ['x'] }]);
      await passes(p('bob'), [{ kind: 'assignment.removeTags', id: 'b1', tags: ['x'] }]);
      await refused(p('dan2'), [{ kind: 'assignment.addTags', id: 'd-ed', tags: ['x'] }], 'escalation');
    });

    it("rules: a role a rule names must not rank above the actor's own at the rule scope", async () => {
      const put = (rule: Record<string, unknown>): AuthzCommand => ({ kind: 'rule.put', rule: { scope: P1, ...rule } as never });
      await refused(p('bob'), [put({ id: 'thr-high', kind: 'threshold', permissions: ['file:read'], minRole: 'maintainer' })], 'escalation');
      await passes(p('bob'), [put({ id: 'thr-low', kind: 'threshold', permissions: ['file:read'], minRole: 'viewer' })]);
      await refused(p('bob'), [put({ id: 'cap-high', kind: 'cap', ladder: 'project', maxRole: 'maintainer' })], 'escalation');
      await passes(p('bob'), [put({ id: 'cap-ref', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.project.cap' } })]);
      await passes(p('bob'), [put({ id: 'cap-null', kind: 'cap', ladder: 'project', maxRole: null })]);
    });

    describe('expiry revivals and extensions are grants', () => {
      const setExpiry = (id: string, expiresAt: Date | null): AuthzCommand => ({ kind: 'assignment.setExpiry', id, expiresAt });

      it('setExpiry renewing a lapsed row or moving an expiry later needs the role covered; moving it earlier does not', async () => {
        await world({ rows: [...BASE, ...admins('root', 'root2'), row('a-old', user('dave'), 'admin', G, { expiresAt: at(-HOUR) }), row('o-old', user('ops'), 'admin', G, { expiresAt: at(-HOUR) }), row('a-exp', user('dave'), 'admin', G, { expiresAt: at(HOUR) })] });
        // ops holds only authz:assignments.manage.
        expect(failure(await run(p('ops'), [setExpiry('a-old', null)]))).to.deep.equal({ at: 0, code: 'escalation', field: 'expiresAt' });
        await refused(p('ops'), [setExpiry('a-old', at(HOUR))], 'escalation');
        await refused(p('ops'), [setExpiry('o-old', null)], 'escalation');
        await refused(p('ops'), [setExpiry('a-exp', null)], 'escalation');
        await refused(p('ops'), [setExpiry('a-exp', at(2 * HOUR))], 'escalation');
        expect((await d.assignments.byId('a-old'))!.expiresAt).to.deep.equal(at(-HOUR));
        await passes(p('ops'), [setExpiry('a-exp', at(HOUR / 2))]);
        await passes(p('root'), [setExpiry('a-old', null), setExpiry('a-exp', null)]);
      });

      it('a ladder role renewed must rank at or below the actor', async () => {
        await world({ rows: [...BASE, ...admins('root'), row('d-mt', user('dave'), 'maintainer', P1, { expiresAt: at(-HOUR) }), row('d-ed', user('dave'), 'editor', P1, { expiresAt: at(-HOUR) })] });
        await refused(p('bob'), [setExpiry('d-mt', null)], 'escalation');
        await passes(p('bob'), [setExpiry('d-ed', null)]);
      });

      it('renewing a set membership reaches the roles the set holds; renewing a set row checks its role', async () => {
        await world({ rows: [...BASE, ...admins('root'), row('s-admin', STAFF, 'admin'), row('m-old', user('dave'), 'staff.set', G, { expiresAt: at(-HOUR) }), row('g-old', GROUP, 'admin', G, { expiresAt: at(-HOUR) })] });
        await refused(p('ops'), [setExpiry('m-old', null)], 'escalation');
        await refused(p('ops'), [setExpiry('g-old', at(HOUR))], 'escalation');
        await passes(p('root'), [setExpiry('m-old', null), setExpiry('g-old', at(HOUR))]);
      });

      it('link.update renewing a lapsed link or moving its expiry later needs its role covered', async () => {
        const link = (id: string, r: string, expiresAt: Date) => ({ link: { id, scope: P1, attributes: {}, expiresAt }, token: `tok-${id}`, role: r });
        await world({ links: [link('l-old', 'maintainer', at(-HOUR)), link('l-exp', 'maintainer', at(HOUR)), link('l-view', 'viewer', at(-HOUR)), link('l-ed', 'editor', at(HOUR))] });
        const update = (id: string, expiresAt: Date | null): AuthzCommand => ({ kind: 'link.update', id, expiresAt });
        expect(failure(await run(p('bob'), [update('l-old', null)]))).to.deep.equal({ at: 0, code: 'escalation', field: 'expiresAt' });
        expect(failure(await run(p('bob'), [update('l-exp', at(2 * HOUR))]))).to.deep.equal({ at: 0, code: 'escalation', field: 'expiresAt' });
        // Moving it earlier is no grant; only the rank check on edits applies ('rank on removals and edits').
        expect(failure(await run(p('bob'), [update('l-exp', at(HOUR / 2))]))).to.deep.equal({ at: 0, code: 'escalation', field: 'id' });
        await passes(p('bob'), [update('l-ed', at(HOUR / 2))]);
        await passes(p('bob'), [update('l-view', null)]);
        await passes(p('root'), [update('l-old', at(HOUR))]);
      });
    });

    it('preventEscalation: false lets every grant through', async () => {
      await world({ guard: { ...GUARD, preventEscalation: false } });
      await passes(p('bob'), [grant('admin'), grant('maintainer'), { kind: 'link.create', scope: P1, role: 'maintainer' }]);
    });
  });

  describe('removals', () => {
    it('no self-lockout: the actor cannot revoke its own privileged role', async () => {
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
      expect(await exists('a-root')).to.equal(true);
    });

    it('the last holder of privilegedPermission at GLOBAL keeps it', async () => {
      await world({ rows: [...BASE, ...admins('root')] });
      await refused(p('ops'), [revoke('a-root')], 'last_holder');
      await world();
      await passes(p('ops'), [revoke('a-root2')]);
    });

    it('self-lockout is checked before last holder', async () => {
      await world({ rows: [...BASE, ...admins('root')] });
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
    });

    it('a privileged row away from GLOBAL is not a holder; a non-privileged GLOBAL row is not either', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('a-p1', user('dave'), 'admin', P1), row('h', user('erin'), 'helper')] });
      await refused(p('ops'), [revoke('a-root')], 'last_holder');
      await passes(p('ops'), [revoke('a-p1'), revoke('h')]);
    });

    it('two revokes of the last two admins in one batch: the second fails last_holder and nothing is committed', async () => {
      await refused(p('ops'), [revoke('a-root'), revoke('a-root2')], 'last_holder', 1);
      expect(await exists('a-root')).to.equal(true);
      expect(await exists('a-root2')).to.equal(true);
    });

    it('revokeWhere is guarded on every row it removes', async () => {
      await refused(p('ops'), [{ kind: 'assignment.revokeWhere', scope: G, role: 'admin' }], 'last_holder');
      await refused(p('root'), [{ kind: 'assignment.revokeWhere', scope: G, subject: user('root') }], 'self_lockout');
      await passes(p('ops'), [{ kind: 'assignment.revokeWhere', scope: G, subject: user('root2') }]);
    });

    it('replaceLadder demoting the last admin fails last_holder; demoting oneself fails self_lockout', async () => {
      await world({ rows: [...BASE, ...admins('root')] });
      await refused(p('super'), [grant('helper', G, user('root'), { replaceLadder: true })], 'last_holder');
      await refused(p('root'), [grant('helper', G, user('root'), { replaceLadder: true })], 'self_lockout');
      expect(await exists('a-root')).to.equal(true);
      await world();
      await passes(p('super'), [grant('helper', G, user('root'), { replaceLadder: true })]);
      expect(await exists('a-root')).to.equal(false);
    });

    it('re-expiry is a removal: setExpiry and a grant that moves the expiry', async () => {
      await world({ rows: [...BASE, ...admins('root')] });
      await refused(p('ops'), [{ kind: 'assignment.setExpiry', id: 'a-root', expiresAt: at(HOUR) }], 'last_holder');
      await refused(p('super'), [grant('admin', G, user('root'), { expiresAt: at(HOUR) })], 'last_holder');
      await refused(p('root'), [{ kind: 'assignment.setExpiry', id: 'a-root', expiresAt: at(HOUR) }], 'self_lockout');
      await passes(p('ops'), [{ kind: 'assignment.setExpiry', id: 'a-root', expiresAt: null }]);
    });

    it('moving an expiry later or renewing a lapsed row is not a removal', async () => {
      await world({ rows: [...BASE, row('a-root', user('root'), 'admin', G, { expiresAt: at(HOUR) }), row('a-old', user('root2'), 'admin', G, { expiresAt: at(-HOUR) })] });
      await passes(p('root'), [{ kind: 'assignment.setExpiry', id: 'a-root', expiresAt: at(2 * HOUR) }]);
      await refused(p('root'), [{ kind: 'assignment.setExpiry', id: 'a-root', expiresAt: at(HOUR / 2) }], 'self_lockout');
      await passes(p('root2'), [grant('admin', G, user('root2'), { expiresAt: at(HOUR) })]);
      await passes(p('root2'), [{ kind: 'assignment.setExpiry', id: 'a-old', expiresAt: at(3 * HOUR) }]);
    });

    it('revoking an expired row of oneself is not a lockout', async () => {
      await world({ rows: [...BASE, ...admins('root2'), row('a-old', user('root'), 'admin', G, { expiresAt: at(-HOUR) })] });
      await passes(p('root'), [revoke('a-old')]);
    });

    it('subject sets: members reach the roles the set holds', async () => {
      const rows = [...BASE, row('s-admin', STAFF, 'admin'), row('m-root', user('root'), 'staff.set'), row('m-root2', user('root2'), 'staff.set')];
      await world({ rows });
      const remove = (id: string): AuthzCommand => ({ kind: 'set.removeMember', set: { role: 'staff.set', scope: G }, member: user(id) });
      await refused(p('root'), [remove('root')], 'self_lockout');
      await refused(p('root'), [revoke('s-admin')], 'self_lockout');
      await refused(p('ops'), [revoke('s-admin')], 'last_holder');
      await refused(p('ops'), [remove('root2'), remove('root')], 'last_holder', 1);
      await passes(p('ops'), [remove('root2')]);
      await world({ rows: [...rows, ...admins('root')] });
      await passes(p('ops'), [revoke('s-admin')]);
    });

    it('a role that implies a privileged role at its own scope is privileged; one implying it only below is not', async () => {
      await world({ rows: [...BASE, row('boss-root', user('root'), 'boss')] });
      await refused(p('root'), [revoke('boss-root')], 'self_lockout');
      await refused(p('ops'), [revoke('boss-root')], 'last_holder');
      await world({ rows: [...BASE, ...admins('root'), row('boss-dave', user('dave'), 'boss')] });
      await passes(p('ops'), [revoke('a-root')]);
      await world({ rows: [...BASE, ...admins('root'), row('far-dave', user('dave'), 'far')] });
      await refused(p('ops'), [revoke('a-root')], 'last_holder');
    });

    it('a link role change and link.revoke are removal paths', async () => {
      await world({ links: [{ link: { id: 'l-pkg', scope: P1, attributes: {} }, token: 'tok', role: 'package' }] });
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-pkg', role: 'viewer' }], 'protected_role');
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-pkg', tags: [] }], 'protected_role');
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-pkg', expiresAt: at(HOUR) }], 'protected_role');
      await refused(p('bob'), [{ kind: 'link.revoke', id: 'l-pkg' }], 'protected_role');
      await passes(SYSTEM, [{ kind: 'link.revoke', id: 'l-pkg' }]);
    });

    it('protectSystemRole: rows of an assignable: false role are revoked, re-tagged and re-expired only by SYSTEM', async () => {
      const rows = [...BASE, ...admins('root'), row('s1', user('dave'), 'package', P1), row('s2', user('dave'), 'sys', P1)];
      await world({ rows });
      for (const c of [revoke('s1'), { kind: 'assignment.addTags', id: 's1', tags: ['x'] }, { kind: 'assignment.removeTags', id: 's1', tags: ['x'] }, { kind: 'assignment.setTags', id: 's1', tags: [] }, { kind: 'assignment.setExpiry', id: 's1', expiresAt: at(HOUR) }, { kind: 'assignment.setExpiry', id: 's1', expiresAt: null }, { kind: 'assignment.revokeWhere', scope: P1, subject: user('dave') }] as AuthzCommand[]) {
        await refused(p('root'), [c], 'protected_role');
      }
      // Checked before self-lockout.
      await world({ rows: [...rows, row('s3', user('root'), 'sys', P1)] });
      await refused(p('root'), [revoke('s3')], 'protected_role');
      await passes(SYSTEM, [revoke('s1'), revoke('s2')]);
    });

    it('protectSystemRole: false lets such rows be revoked through the API', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('s1', user('dave'), 'package', P1)], guard: { ...GUARD, protectSystemRole: false } });
      await passes(p('root'), [{ kind: 'assignment.addTags', id: 's1', tags: ['x'] }, revoke('s1')]);
    });

    it('a system role row is no holder and no other path, as the model ignores it; revoking it stays protected', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('s-dave', user('dave'), 'sys')] });
      await refused(p('ops'), [revoke('a-root')], 'last_holder');
      await refused(p('ops'), [revoke('s-dave')], 'protected_role');
      await world({ rows: [...BASE, ...admins('root', 'root2'), row('s-root', user('root'), 'sys')] });
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
    });

    it('a row at a scope type its role may not be held at, or of an unknown role, is no holder and no other path', async () => {
      const roles = [...GUARD_ROLES, role('org.boss', { scopeTypes: ['org'], grants: grants('users:update') })];
      const ignored = [row('ob-dave', user('dave'), 'org.boss'), row('u-dave', user('dave'), 'no.such.role'), row('s-boss', STAFF, 'org.boss'), row('m-dave', user('dave'), 'staff.set')];
      await world({ rows: [...BASE, ...admins('root'), ...ignored], roles });
      await refused(p('ops'), [revoke('a-root')], 'last_holder');
      await world({ rows: [...BASE, ...admins('root', 'root2'), row('ob-root', user('root'), 'org.boss')], roles });
      await refused(p('root'), [revoke('a-root')], 'self_lockout');
    });

    describe('last holder: only holders the model surely honours at GLOBAL count', () => {
      const cond = (name: string, grant: Record<string, unknown>, extra: Partial<RoleDef> = {}): RoleDef => role(name, { grants: [{ permission: 'users:update', ...grant }], ...extra });
      const ROLES = [...GUARD_ROLES, cond('tagged', { requiresTag: 'mfa' }), cond('related', { relation: 'owner' }), cond('patterned', { on: [{ type: 'users', id: '{principal.id}' }] }), cond('prov', { grantedAt: ['org'] }), cond('wide', { grantedAt: ['$global'] }), cond('tier.low', { grantedAt: ['$global'] }, { ladder: 'tier' }), role('tier.high', { ladder: 'tier' }), role('tier.ext', { extends: ['tier.low'] }), role('org.boss', { ladder: 'orgs', grants: grants('users:update') }), role('org.member', { ladder: 'org', subjectSet: true }), role('org.admin', { ladder: 'org' })];
      const LADDERS = [...GUARD_LADDERS, { name: 'tier', roles: ['tier.low', 'tier.high'] }, { name: 'orgs', roles: ['org.boss'], resourceTypes: ['org'] }, { name: 'org', roles: ['org.member', 'org.admin'] }];
      const S_ORG = row('s-org', { set: { role: 'org.member', scope: O1 } }, 'admin');
      const only = (rows: readonly Assignment[], links?: RbacDomainOptions['links'], root = row('a-root', user('root'), 'admin')) => world({ rows: [...BASE, root, ...rows], roles: ROLES, ladders: LADDERS, links });

      it('a grant with a tag, relation, on, or a grantedAt or ladder the GLOBAL row does not meet gives no holder', async () => {
        // tier.ext reaches tier.low's grant through extends, but provenance counts only rows on tier.low's ladder.
        for (const r of ['tagged', 'related', 'patterned', 'prov', 'org.boss', 'tier.ext']) {
          await only([row('x-dave', user('dave'), r)]);
          await refused(p('ops'), [revoke('a-root')], 'last_holder');
        }
        for (const r of ['wide', 'tier.low', 'tier.high', 'admin', 'boss']) {
          await only([row('x-dave', user('dave'), r)]);
          await passes(p('ops'), [revoke('a-root')]);
        }
      });

      it('a share link is no holder through a set, whether its role is the set role or above it', async () => {
        await only([S_ORG], [{ link: { id: 'l-oa', scope: O1, attributes: {} }, token: 'tok-oa', role: 'org.admin' }]);
        await refused(p('ops'), [revoke('a-root')], 'last_holder');
        await only([S_ORG], [{ link: { id: 'l-om', scope: O1, attributes: {} }, token: 'tok-om', role: 'org.member' }]);
        await refused(p('ops'), [revoke('a-root')], 'last_holder');
        await only([S_ORG, row('oa-dave', user('dave'), 'org.admin', O1)]);
        await passes(p('ops'), [revoke('a-root')]);
      });

      it('every row of a remaining path must last as long as the removed rows would', async () => {
        await only([row('a-dave', user('dave'), 'admin', G, { expiresAt: at(HOUR) })]);
        await refused(p('ops'), [revoke('a-root')], 'last_holder');
        await only([S_ORG, row('oa-dave', user('dave'), 'org.admin', O1, { expiresAt: at(HOUR) })]);
        await refused(p('ops'), [revoke('a-root')], 'last_holder');
        const expiring = row('a-root', user('root'), 'admin', G, { expiresAt: at(HOUR) });
        await only([row('a-dave', user('dave'), 'admin', G, { expiresAt: at(HOUR) })], undefined, expiring);
        await passes(p('ops'), [revoke('a-root')]);
        await only([row('a-dave', user('dave'), 'admin', G, { expiresAt: at(HOUR / 2) })], undefined, expiring);
        await refused(p('ops'), [revoke('a-root')], 'last_holder');
        await only([S_ORG, row('oa-dave', user('dave'), 'org.admin', O1, { expiresAt: at(2 * HOUR) })], undefined, expiring);
        await passes(p('ops'), [revoke('a-root')]);
      });

      it('a removal on no path passes even when no holder is sure', async () => {
        await world({ rows: [...BASE, row('t-root', user('root'), 'tagged'), row('h', user('erin'), 'helper')], roles: ROLES, ladders: LADDERS });
        await passes(p('ops'), [revoke('h')]);
        await refused(p('ops'), [revoke('t-root')], 'last_holder');
      });
    });

    describe('permissions that imply privilegedPermission grant it (PermissionDef.implies)', () => {
      // users:own implies users:manage, which implies users:update; users:update implies users:read.
      const IMPLIES = { 'users:manage': { implies: ['users:update'] }, 'users:own': { implies: ['users:manage'] }, 'users:update': { implies: ['users:read'] } };
      const ROLES = [...GUARD_ROLES, role('umanage', { grants: grants('users:manage') }), role('uown', { grants: grants('users:own') }), role('uglob', { grants: grants('users:man*') }), role('utagged', { grants: [{ permission: 'users:manage', requiresTag: 'mfa' }] }), role('uprov', { grants: [{ permission: 'users:manage', grantedAt: ['org'] }] })];
      const implying = (rows: readonly Assignment[]) => world({ rows: [...BASE, ...rows], roles: ROLES, permissions: IMPLIES });
      const IMPLYING = ['umanage', 'uown', 'uglob'];

      it('last holder: a GLOBAL row granting an implying permission, directly, transitively or by a glob, is a holder', async () => {
        for (const r of IMPLYING) {
          await implying([row('u-root', user('root'), r)]);
          await refused(p('ops'), [revoke('u-root')], 'last_holder');
          expect(await exists('u-root')).to.equal(true);
          await implying([...admins('root'), row('u-dave', user('dave'), r)]);
          await passes(p('ops'), [revoke('a-root')]);
        }
      });

      it('self-lockout: an own row granting an implying permission lies on a path', async () => {
        for (const r of IMPLYING) {
          await implying([...admins('root2'), row('u-root', user('root'), r)]);
          await refused(p('root'), [revoke('u-root')], 'self_lockout');
        }
      });

      it('subject sets: a set row granting an implying permission makes its members holders', async () => {
        const rows = [row('s-u', STAFF, 'umanage'), row('m-root', user('root'), 'staff.set')];
        await implying(rows);
        await refused(p('ops'), [revoke('s-u')], 'last_holder');
        await refused(p('root'), [{ kind: 'set.removeMember', set: { role: 'staff.set', scope: G }, member: user('root') }], 'self_lockout');
        await implying([...admins('root'), ...rows]);
        await passes(p('ops'), [revoke('a-root')]);
      });

      it('a grant matched through an implied permission is sure only on the same conditions', async () => {
        for (const r of ['utagged', 'uprov']) {
          await implying([...admins('root'), row('u-dave', user('dave'), r)]);
          await refused(p('ops'), [revoke('a-root')], 'last_holder');
        }
      });

      it('a permission that privilegedPermission implies gives no holder', async () => {
        await implying([...admins('root'), row('h', user('erin'), 'helper')]);
        await refused(p('ops'), [revoke('a-root')], 'last_holder');
        await passes(p('ops'), [revoke('h')]);
      });

      it('with no registry to read the implies from, a removal rejects the call and a grant is not covered', async () => {
        await world({ registry: false });
        const e = await rejection(run(p('ops'), [revoke('a-root2')]));
        expect(e).to.be.instanceOf(AuthzConfigError);
        expect(e.message).to.include('PermissionRegistry');
        await refused(p('root'), [grant('viewer')], 'escalation');
        await passes(p('root'), [grant('staff.set')]);
      });
    });

    it('SYSTEM skips the guard (AuthzAdmin does not call it)', async () => {
      await world({ rows: [...BASE, ...admins('root')] });
      await passes(SYSTEM, [revoke('a-root')]);
    });

    it('the prevent switches turn their checks off', async () => {
      await world({ guard: { ...GUARD, preventSelfLockout: false } });
      await passes(p('root'), [revoke('a-root')]);
      await world({ rows: [...BASE, ...admins('root')], guard: { ...GUARD, preventLastPrivilegedRemoval: false } });
      await passes(p('ops'), [revoke('a-root')]);
      await world({ rows: [...BASE, ...admins('root')], guard: { ...GUARD, preventSelfLockout: false, preventLastPrivilegedRemoval: false } });
      await passes(p('root'), [revoke('a-root')]);
    });

    it('a dry run runs the guard too', async () => {
      const f = failure(await d.admin.execute(p('root'), [revoke('a-root')], { dryRun: true }));
      expect(f.code).to.equal('self_lockout');
    });
  });

  describe('rank on removals and edits', () => {
    // bob ranks editor at p1, erin maintainer; root ranks maintainer everywhere.
    const tagged = { tags: ['keep'] };
    const ROWS: Assignment[] = [...BASE, ...admins('root'), row('d-mt', user('dave'), 'maintainer', P1, tagged), row('e-ed', user('eve'), 'editor', P1, tagged), row('f-vw', user('fay'), 'viewer', P1, tagged)];
    const LINKS = [
      { link: { id: 'l-mt', scope: P1, attributes: {} }, token: 'tok-mt', role: 'maintainer', tags: ['keep'] },
      { link: { id: 'l-ed', scope: P1, attributes: {} }, token: 'tok-ed', role: 'editor', tags: ['keep'] },
    ];
    const fresh = (extra: readonly Assignment[] = [], guard?: Record<string, unknown>) => world({ rows: [...ROWS, ...extra], links: LINKS, guard });
    const refusedAt = async (actor: Principal, c: AuthzCommand, field?: string): Promise<void> => {
      expect(failure(await run(actor, [c]))).to.deep.equal({ at: 0, code: 'escalation', ...(field !== undefined ? { field } : {}) });
    };
    const removeTags = (id: string): AuthzCommand => ({ kind: 'assignment.removeTags', id, tags: ['keep'] });
    const setExpiry = (id: string, expiresAt: Date | null): AuthzCommand => ({ kind: 'assignment.setExpiry', id, expiresAt });

    it('revoke: the row role must rank at or below the actor on its ladder at the row scope', async () => {
      await fresh();
      await refusedAt(p('bob'), revoke('d-mt'), 'id');
      expect(await exists('d-mt')).to.equal(true);
      await passes(p('bob'), [revoke('e-ed'), revoke('f-vw')]);
      await passes(p('erin'), [revoke('d-mt')]);
      await fresh();
      await passes(p('root'), [revoke('d-mt')]);
    });

    it('the message names the actor, the role, the scope and the ladder', async () => {
      await fresh();
      const [r] = await run(p('bob'), [revoke('d-mt')]);
      const message = (r as Extract<AuthzCommandResult, { ok: false }>).error.message;
      for (const part of ['user:bob', '"maintainer"', '"p1"', 'ladder "project"', '(assignment "d-mt")']) expect(message).to.include(part);
      const [l] = await run(p('bob'), [{ kind: 'link.revoke', id: 'l-mt' }]);
      expect((l as Extract<AuthzCommandResult, { ok: false }>).error.message).to.include('(link "l-mt")');
    });

    it('revokeWhere: one higher row refuses the whole command', async () => {
      await fresh();
      expect(failure(await run(p('bob'), [{ kind: 'assignment.revokeWhere', scope: P1 }]))).to.deep.equal({ at: 0, code: 'escalation' });
      expect(await exists('e-ed')).to.equal(true);
      await passes(p('bob'), [{ kind: 'assignment.revokeWhere', scope: P1, role: 'editor' }]);
      expect(await exists('e-ed')).to.equal(false);
      await passes(p('erin'), [{ kind: 'assignment.revokeWhere', scope: P1, subject: user('dave') }]);
    });

    it('replaceLadder: a grant that revokes a higher row of the ladder is refused', async () => {
      await fresh();
      await refusedAt(p('bob'), grant('viewer', P1, user('dave'), { replaceLadder: true }), 'replaceLadder');
      expect(await exists('d-mt')).to.equal(true);
      await passes(p('bob'), [grant('viewer', P1, user('eve'), { replaceLadder: true })]);
      expect(await exists('e-ed')).to.equal(false);
      await passes(p('erin'), [grant('viewer', P1, user('dave'), { replaceLadder: true })]);
    });

    it('setExpiry: moving the expiry of a higher row earlier is refused', async () => {
      await fresh();
      await refusedAt(p('bob'), setExpiry('d-mt', at(HOUR)), 'id');
      await passes(p('bob'), [setExpiry('e-ed', at(HOUR)), setExpiry('f-vw', at(HOUR))]);
      await passes(p('erin'), [setExpiry('d-mt', at(HOUR))]);
    });

    it('tags: setTags or removeTags on a higher row is refused, even when it adds nothing', async () => {
      await fresh();
      await refusedAt(p('bob'), removeTags('d-mt'), 'id');
      await refusedAt(p('bob'), { kind: 'assignment.setTags', id: 'd-mt', tags: [] }, 'id');
      await refusedAt(p('bob'), { kind: 'assignment.addTags', id: 'd-mt', tags: ['keep'] }, 'id');
      expect((await d.assignments.byId('d-mt'))!.tags).to.deep.equal(['keep']);
      await passes(p('bob'), [removeTags('e-ed'), { kind: 'assignment.setTags', id: 'f-vw', tags: [] }]);
      await passes(p('erin'), [removeTags('d-mt')]);
      await passes(p('root'), [{ kind: 'assignment.setTags', id: 'd-mt', tags: [] }]);
    });

    it('subject sets: removing a member takes the roles the set holds, each checked at its own scope', async () => {
      const remove: AuthzCommand = { kind: 'set.removeMember', set: { role: 'group.member', scope: GR }, member: user('dave') };
      const member = row('m-dave', user('dave'), 'group.member', GR);
      await fresh([member, row('g-mt', GROUP, 'maintainer', P1)]);
      expect(failure(await run(p('bob'), [remove]))).to.deep.equal({ at: 0, code: 'escalation' });
      await refusedAt(p('bob'), revoke('m-dave'), 'id');
      await refusedAt(p('bob'), setExpiry('m-dave', at(HOUR)), 'id');
      await passes(p('root'), [remove]);
      await fresh([member, row('g-ed', GROUP, 'editor', P1)]);
      await passes(p('bob'), [setExpiry('m-dave', at(HOUR)), remove]);
    });

    it('subject sets: an earlier link expiry takes the roles of the set the link is a member of', async () => {
      table.set('bob', GR, { allow: ['authz:assignments.manage', 'authz:links.manage'] });
      const links = [
        { link: { id: 'l-gm', scope: GR, attributes: {}, expiresAt: at(2 * HOUR) }, token: 'tok-gm', role: 'group.member' },
        { link: { id: 'l-gn', scope: GR, attributes: {} }, token: 'tok-gn', role: 'group.member' },
      ];
      const shorten = (id: string): AuthzCommand => ({ kind: 'link.update', id, expiresAt: at(HOUR) });
      await world({ rows: [...ROWS, row('g-mt', GROUP, 'maintainer', P1)], links });
      await refusedAt(p('bob'), shorten('l-gm'), 'id');
      await refusedAt(p('bob'), shorten('l-gn'), 'id');
      await passes(p('root'), [shorten('l-gm'), shorten('l-gn')]);
      await world({ rows: [...ROWS, row('g-ed', GROUP, 'editor', P1)], links });
      await passes(p('bob'), [shorten('l-gm'), shorten('l-gn')]);
    });

    it('subject sets: revoking a set row checks the role it holds', async () => {
      await fresh([row('g-mt', GROUP, 'maintainer', P1), row('g-ed', GROUP, 'editor', P1)]);
      await refusedAt(p('bob'), revoke('g-mt'), 'id');
      await passes(p('bob'), [revoke('g-ed')]);
      await passes(p('erin'), [revoke('g-mt')]);
    });

    it('links: link.revoke and link.update of a link granting a higher role are refused', async () => {
      await fresh();
      await refusedAt(p('bob'), { kind: 'link.revoke', id: 'l-mt' }, 'id');
      await refusedAt(p('bob'), { kind: 'link.update', id: 'l-mt', role: 'viewer' }, 'id');
      await refusedAt(p('bob'), { kind: 'link.update', id: 'l-mt', tags: [] }, 'id');
      await refusedAt(p('bob'), { kind: 'link.update', id: 'l-mt', expiresAt: at(HOUR) }, 'id');
      await passes(p('bob'), [
        { kind: 'link.update', id: 'l-ed', tags: [] },
        { kind: 'link.update', id: 'l-ed', expiresAt: at(HOUR) },
        { kind: 'link.update', id: 'l-ed', role: 'viewer' },
        { kind: 'link.revoke', id: 'l-ed' },
      ]);
      await passes(p('root'), [
        { kind: 'link.update', id: 'l-mt', tags: [] },
        { kind: 'link.update', id: 'l-mt', role: 'editor' },
        { kind: 'link.revoke', id: 'l-mt' },
      ]);
    });

    it('implied roles: a role on no ladder that implies a higher ladder role is ranked as its grant is', async () => {
      // lead implies maintainer at p1: bob ranks editor there, erin maintainer.
      await fresh([row('d-lead', user('dave'), 'lead', P1, tagged)]);
      await refusedAt(p('bob'), revoke('d-lead'), 'id');
      await refusedAt(p('bob'), setExpiry('d-lead', at(HOUR)), 'id');
      await refusedAt(p('bob'), removeTags('d-lead'), 'id');
      await refusedAt(p('bob'), { kind: 'assignment.setTags', id: 'd-lead', tags: [] }, 'id');
      await refusedAt(p('bob'), { kind: 'assignment.revokeWhere', scope: P1, role: 'lead' });
      const [r] = await run(p('bob'), [revoke('d-lead')]);
      const message = (r as Extract<AuthzCommandResult, { ok: false }>).error.message;
      for (const part of ['"lead"', 'gives "maintainer"', 'ladder "project"']) expect(message).to.include(part);
      expect(await d.assignments.byId('d-lead')).to.deep.include({ tags: ['keep'], expiresAt: null });
      await passes(p('erin'), [removeTags('d-lead'), setExpiry('d-lead', at(HOUR)), revoke('d-lead')]);
      expect(await exists('d-lead')).to.equal(false);
    });

    it('implied roles: a role extending one that implies a higher ladder role is ranked too', async () => {
      const roles = [...GUARD_ROLES, role('sublead', { extends: ['lead'] })];
      await world({ rows: [...ROWS, row('d-sub', user('dave'), 'sublead', P1)], roles });
      await refusedAt(p('bob'), revoke('d-sub'), 'id');
      await passes(p('erin'), [revoke('d-sub')]);
    });

    it('an expired higher row counts (fail closed)', async () => {
      await fresh([row('d-old', user('dave'), 'maintainer', P1, { expiresAt: at(-HOUR) })]);
      await refusedAt(p('bob'), revoke('d-old'), 'id');
      await refusedAt(p('bob'), removeTags('d-old'), 'id');
      await passes(p('erin'), [revoke('d-old')]);
    });

    it('an actor without a rank on the ladder may not remove its roles; a role on no ladder is not ranked', async () => {
      table.set('clerk', '*', { allow: ['authz:assignments.manage'] });
      await fresh([row('d-glob', user('dave'), 'globber', P1)]);
      await refusedAt(p('clerk'), revoke('a-root'), 'id');
      await refusedAt(p('clerk'), revoke('f-vw'), 'id');
      // globber is on no ladder, and revoking asks for no covers.
      await passes(p('bob'), [revoke('d-glob')]);
    });

    it('protected_role is checked before the rank', async () => {
      const roles = [...GUARD_ROLES, role('keeper', { ladder: 'staff', assignable: false })];
      const ladders = [GUARD_LADDERS[0], { name: 'staff', roles: ['helper', 'admin', 'keeper'] }];
      const rows = [...ROWS, row('k-dave', user('dave'), 'keeper')];
      await world({ rows, roles, ladders });
      // ops ranks admin, below keeper.
      await refused(p('ops'), [revoke('k-dave')], 'protected_role');
      await world({ rows, roles, ladders, guard: { ...GUARD, protectSystemRole: false } });
      await refusedAt(p('ops'), revoke('k-dave'), 'id');
    });

    it('preventEscalation: false turns the rank check on removals off', async () => {
      await fresh([], { ...GUARD, preventEscalation: false });
      await passes(p('bob'), [removeTags('d-mt'), grant('viewer', P1, user('dave'), { replaceLadder: true }), { kind: 'link.revoke', id: 'l-mt' }]);
      expect(await exists('d-mt')).to.equal(false);
      await fresh([], { ...GUARD, preventEscalation: false });
      await passes(p('bob'), [revoke('d-mt')]);
    });
  });

  describe('subject sets through role closures', () => {
    // org.admin ranks above the subject set role org.member; org.lead (a set) and org.helper extend it.
    const ROLES = [...GUARD_ROLES, role('org.member', { ladder: 'org', subjectSet: true, grants: grants('authz:assignments.read') }), role('org.admin', { ladder: 'org' }), role('org.lead', { subjectSet: true, extends: ['org.member'] }), role('org.helper', { extends: ['org.member'] }), role('team.helper', { extends: ['org.member'], scopeTypes: ['group'] }), role('locked.helper', { extends: ['org.member'], assignable: false })];
    const LADDERS = [...GUARD_LADDERS, { name: 'org', roles: ['org.member', 'org.admin'] }];
    const ORG: AssignmentSubject = { set: { role: 'org.member', scope: O1 } };
    const LEAD: AssignmentSubject = { set: { role: 'org.lead', scope: O1 } };
    const closure = (rows: readonly Assignment[], links?: RbacDomainOptions['links']) => world({ rows: [...BASE, ...rows], roles: ROLES, ladders: LADDERS, links });
    const addMember = (set: string, member: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: set, scope: O1 }, member: user(member) });
    const setExpiry = (id: string, expiresAt: Date | null): AuthzCommand => ({ kind: 'assignment.setExpiry', id, expiresAt });
    const refusedAt = async (actor: Principal, c: AuthzCommand, code: string, field?: string): Promise<void> => {
      expect(failure(await run(actor, [c]))).to.deep.equal({ at: 0, code, ...(field !== undefined ? { field } : {}) });
    };
    const ORG_ADMIN = { allow: ['authz:*.manage', 'authz:assignments.read'], roles: { org: 'org.admin' } };

    beforeEach(() => {
      const top = { allow: ['*'], roles: { project: 'maintainer', staff: 'admin', org: 'org.admin' } };
      for (const id of ['root', 'root2', 'super']) table.set(id, '*', top);
      table.set('ops', '*', { allow: ['authz:assignments.manage', 'authz:assignments.read'], roles: { staff: 'admin', org: 'org.admin' } });
      // olga runs the org and holds every permission of maintainer at p1, but ranks editor there; omar ranks maintainer.
      table.set('olga', O1, ORG_ADMIN);
      table.set('olga', P1, { allow: ['file:read', 'file:edit', 'project:settings', 'authz:*.manage'], roles: { project: 'editor' } });
      table.set('omar', O1, ORG_ADMIN);
      table.set('omar', P1, { allow: ['file:read', 'file:edit', 'project:settings', 'authz:*.manage'], roles: { project: 'maintainer' } });
    });

    describe('escalation', () => {
      it('a higher ladder role makes its holder a member of the lower subject set role, so it gives what the set holds', async () => {
        await closure([row('o-mt', ORG, 'maintainer', P1)]);
        const [r] = await run(p('olga'), [grant('org.admin', O1, user('dave'))]);
        expect(failure([r])).to.deep.equal({ at: 0, code: 'escalation', field: 'role' });
        const message = (r as Extract<AuthzCommandResult, { ok: false }>).error.message;
        for (const part of ['"maintainer"', '"p1"', 'ladder "project"', 'may not grant "org.admin" at {"type":"org","id":"o1"}: it makes the subject a member of "org.member" at {"type":"org","id":"o1"}, which holds "maintainer" at {"type":"project","id":"p1"}']) expect(message).to.include(part);
        await refusedAt(p('olga'), grant('org.member', O1, user('dave')), 'escalation', 'role');
        await passes(p('omar'), [grant('org.admin', O1, user('dave'))]);
        await closure([row('o-ed', ORG, 'editor', P1)]);
        await passes(p('olga'), [grant('org.admin', O1, user('dave'))]);
      });

      it('a role that extends a subject set role gives what the set holds', async () => {
        await closure([row('o-mt', ORG, 'maintainer', P1)]);
        await refusedAt(p('olga'), grant('org.helper', O1, user('dave')), 'escalation', 'role');
        await refusedAt(p('olga'), addMember('org.lead', 'dave'), 'escalation', 'set.role');
        await passes(p('omar'), [grant('org.helper', O1, user('dave')), addMember('org.lead', 'dave')]);
        await closure([row('o-ed', ORG, 'editor', P1)]);
        await passes(p('olga'), [grant('org.helper', O1, user('dave')), addMember('org.lead', 'dave')]);
      });

      it('a set role reaches what its own set holds; a role below it in the closure does not', async () => {
        await closure([row('l-mt', LEAD, 'maintainer', P1)]);
        await refusedAt(p('olga'), addMember('org.lead', 'dave'), 'escalation', 'set.role');
        await passes(p('olga'), [grant('org.admin', O1, user('dave'))]);
      });

      it('links and expiry extensions follow the closure', async () => {
        const links = [{ link: { id: 'l-oa', scope: O1, attributes: {}, expiresAt: at(-HOUR) }, token: 'tok-oa', role: 'org.admin' }];
        await closure([row('o-mt', ORG, 'maintainer', P1), row('oa-dave', user('dave'), 'org.admin', O1, { expiresAt: at(-HOUR) })], links);
        await refusedAt(p('olga'), { kind: 'link.create', scope: O1, role: 'org.admin' }, 'escalation', 'role');
        await refusedAt(p('olga'), { kind: 'link.update', id: 'l-oa', expiresAt: null }, 'escalation', 'expiresAt');
        await refusedAt(p('olga'), setExpiry('oa-dave', null), 'escalation', 'expiresAt');
        await passes(p('omar'), [{ kind: 'link.create', scope: O1, role: 'org.admin' }, { kind: 'link.update', id: 'l-oa', expiresAt: null }, setExpiry('oa-dave', null)]);
      });

      it('a grant to a set makes no member of another set', async () => {
        await closure([row('o-mt', ORG, 'maintainer', P1)]);
        await passes(p('olga'), [grant('org.admin', O1, LEAD)]);
      });

      it('removing a higher ladder role or an extending role takes the roles of the subject set role below it', async () => {
        await closure([row('o-mt', ORG, 'maintainer', P1), row('oa-dave', user('dave'), 'org.admin', O1), row('oh-dave', user('dave'), 'org.helper', O1)]);
        await refusedAt(p('olga'), revoke('oa-dave'), 'escalation', 'id');
        await refusedAt(p('olga'), setExpiry('oa-dave', at(HOUR)), 'escalation', 'id');
        await refusedAt(p('olga'), revoke('oh-dave'), 'escalation', 'id');
        expect(await exists('oa-dave')).to.equal(true);
        await passes(p('omar'), [setExpiry('oa-dave', at(HOUR)), revoke('oa-dave'), revoke('oh-dave')]);
      });
    });

    describe('removals', () => {
      // The org.member set at o1 holds admin, the privileged role, at GLOBAL.
      const S_ORG = row('s-org', ORG, 'admin');

      it('last holder: a member by closure is a holder', async () => {
        await closure([S_ORG, row('oa-root', user('root'), 'org.admin', O1)]);
        await refusedAt(p('ops'), revoke('oa-root'), 'last_holder', 'id');
        await refusedAt(p('ops'), revoke('s-org'), 'last_holder', 'id');
        await refusedAt(p('ops'), setExpiry('oa-root', at(HOUR)), 'last_holder', 'id');
        await closure([S_ORG, row('ol-root', user('root'), 'org.lead', O1)]);
        await refusedAt(p('ops'), revoke('ol-root'), 'last_holder', 'id');
        await closure([S_ORG, row('oh-root', user('root'), 'org.helper', O1)]);
        await refusedAt(p('ops'), revoke('oh-root'), 'last_holder', 'id');
        await closure([S_ORG, row('oa-root', user('root'), 'org.admin', O1), ...admins('root2')]);
        await passes(p('ops'), [revoke('oa-root')]);
      });

      it('self-lockout: a row whose closure holds a set role on a privileged path', async () => {
        await closure([S_ORG, row('oa-root', user('root'), 'org.admin', O1), ...admins('root2')]);
        await refusedAt(p('root'), revoke('oa-root'), 'self_lockout', 'id');
        await refusedAt(p('root'), setExpiry('oa-root', at(HOUR)), 'self_lockout', 'id');
        await closure([S_ORG, row('oh-root', user('root'), 'org.helper', O1), ...admins('root2')]);
        await refusedAt(p('root'), revoke('oh-root'), 'self_lockout', 'id');
        await refusedAt(p('root'), revoke('s-org'), 'self_lockout', 'id');
      });

      it('self-lockout: another path does not save a removal on a path (the guard cannot judge the other path)', async () => {
        const both = [S_ORG, row('om-root', user('root'), 'org.member', O1), row('oa-root', user('root'), 'org.admin', O1), ...admins('root2')];
        await closure(both);
        await refusedAt(p('root'), revoke('om-root'), 'self_lockout', 'id');
        await refusedAt(p('root'), revoke('oa-root'), 'self_lockout', 'id');
        await refusedAt(p('root'), { kind: 'assignment.revokeWhere', scope: O1, subject: user('root') }, 'self_lockout');
        const mixed = [S_ORG, row('oa-root', user('root'), 'org.admin', O1), ...admins('root', 'root2')];
        await closure(mixed);
        await refusedAt(p('root'), revoke('oa-root'), 'self_lockout', 'id');
        await refusedAt(p('root'), revoke('a-root'), 'self_lockout', 'id');
        expect([await exists('oa-root'), await exists('a-root')]).to.deep.equal([true, true]);
      });

      it('rows the model ignores make no member: no holder and no other path', async () => {
        // team.helper may not be held at an org; locked.helper is assignable: false.
        const ignored = [S_ORG, row('th-root', user('root'), 'team.helper', O1), row('lh-root', user('root'), 'locked.helper', O1)];
        await closure([...ignored, ...admins('root2')]);
        await refusedAt(p('ops'), revoke('a-root2'), 'last_holder', 'id');
        await closure([...ignored, ...admins('root', 'root2')]);
        await refusedAt(p('root'), revoke('a-root'), 'self_lockout', 'id');
        await closure([...ignored, row('om-root', user('root'), 'org.member', O1), ...admins('root2')]);
        await passes(p('ops'), [revoke('a-root2')]);
      });

      it('self-lockout: a privileged row at another scope is no other path', async () => {
        await closure([S_ORG, row('oa-root', user('root'), 'org.admin', O1), row('a-p1', user('root'), 'admin', P1), ...admins('root2')]);
        await refusedAt(p('root'), revoke('oa-root'), 'self_lockout', 'id');
      });
    });
  });

  async function rbacDomainWithoutRoles(): Promise<RbacDomain> {
    return rbacDomain('bare', { without: ['roles'], admin: { backend: 'TestBackend', guard: GUARD }, model: table.model(), permissions: USER_PERMISSIONS });
  }
});
