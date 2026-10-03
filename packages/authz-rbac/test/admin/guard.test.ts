import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AuthzConfigError, SYSTEM, TRUE, compilePermissionGlob, resourceKey } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand, AuthzCommandResult, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { CheckRbacAdminFacts, DefaultAdminGuard, RbacAdminFacts } from '../../src/index.js';
import type { Assignment, AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { G, GR, HOUR, P1, START, StaticRoleStore, config, failure, installHost, ok, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain, RbacDomainOptions } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
const grants = (...names: string[]) => names.map((permission) => ({ permission }));
const MANAGE = ['authz:assignments.manage', 'authz:links.manage', 'authz:rules.manage'];

export const GUARD_ROLES: RoleDef[] = [role('viewer', { ladder: 'project', grants: grants('file:read') }), role('editor', { ladder: 'project', grants: grants('file:edit') }), role('maintainer', { ladder: 'project', grants: grants('project:settings') }), role('helper', { ladder: 'staff', grants: grants('users:read') }), role('admin', { ladder: 'staff', grants: grants('users:update', 'authz:assignments.manage') }), role('ops', { grants: grants('authz:assignments.manage') }), role('manager', { grants: grants(...MANAGE) }), role('globber', { grants: grants('file:*') }), role('reader', { extends: ['viewer'] }), role('sys', { assignable: false, grants: grants('users:update') }), role('package', { assignable: false, grants: grants('file:read') }), role('group.member', { subjectSet: true, scopeTypes: ['group'] }), role('staff.set', { subjectSet: true })];
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
  }

  async function world(opts: WorldOptions = {}): Promise<RbacDomain> {
    await resetHost();
    d = await rbacDomain('test', {
      roleStores: [new StaticRoleStore('guard', GUARD_ROLES, GUARD_LADDERS)],
      assignments: opts.rows ?? [...BASE, ...admins('root', 'root2')],
      links: opts.links,
      admin: { backend: 'TestBackend', guard: opts.guard ?? GUARD },
      model: table.model(),
      permissions: USER_PERMISSIONS,
      register: opts.register,
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
    table.set('ops', '*', { allow: ['authz:assignments.manage'] });
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

    it('a glob grant counts as not covered (fail closed)', async () => {
      await refused(p('erin'), [grant('globber')], 'escalation');
      await passes(p('erin'), [grant('viewer')]);
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

    it('links: adding tags to a link checks its role', async () => {
      await world({ links: [{ link: { id: 'l-mt', scope: P1, attributes: {} }, token: 'tok', role: 'maintainer' }] });
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-mt', tags: ['x'] }], 'escalation');
      await passes(p('bob'), [{ kind: 'link.update', id: 'l-mt', attributes: { org_only: true } }]);
      await passes(p('bob'), [{ kind: 'link.update', id: 'l-mt', tags: [] }]);
    });

    it('tags: adding a tag checks the row role; removing does not', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('d-mt', user('dave'), 'maintainer', P1, { tags: ['keep'] })] });
      await refused(p('bob'), [{ kind: 'assignment.addTags', id: 'd-mt', tags: ['x'] }], 'escalation');
      await refused(p('bob'), [{ kind: 'assignment.setTags', id: 'd-mt', tags: ['keep', 'x'] }], 'escalation');
      await passes(p('bob'), [{ kind: 'assignment.addTags', id: 'd-mt', tags: ['keep'] }]);
      await passes(p('bob'), [{ kind: 'assignment.setTags', id: 'd-mt', tags: [] }]);
      await passes(p('bob'), [{ kind: 'assignment.removeTags', id: 'd-mt', tags: ['keep'] }]);
      await passes(p('bob'), [{ kind: 'assignment.addTags', id: 'b1', tags: ['x'] }]);
    });

    it("rules: a role a rule names must not rank above the actor's own at the rule scope", async () => {
      const put = (rule: Record<string, unknown>): AuthzCommand => ({ kind: 'rule.put', rule: { scope: P1, ...rule } as never });
      await refused(p('bob'), [put({ id: 'thr-high', kind: 'threshold', permissions: ['file:read'], minRole: 'maintainer' })], 'escalation');
      await passes(p('bob'), [put({ id: 'thr-low', kind: 'threshold', permissions: ['file:read'], minRole: 'viewer' })]);
      await refused(p('bob'), [put({ id: 'cap-high', kind: 'cap', ladder: 'project', maxRole: 'maintainer' })], 'escalation');
      await passes(p('bob'), [put({ id: 'cap-ref', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.project.cap' } })]);
      await passes(p('bob'), [put({ id: 'cap-null', kind: 'cap', ladder: 'project', maxRole: null })]);
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

    it('a link role change and link.revoke are removal paths', async () => {
      await world({ links: [{ link: { id: 'l-pkg', scope: P1, attributes: {} }, token: 'tok', role: 'package' }] });
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-pkg', role: 'viewer' }], 'protected_role');
      await refused(p('bob'), [{ kind: 'link.update', id: 'l-pkg', tags: [] }], 'protected_role');
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

    it('a system role that grants privilegedPermission at GLOBAL makes its subject a holder', async () => {
      await world({ rows: [...BASE, ...admins('root'), row('s-dave', user('dave'), 'sys')] });
      await passes(p('ops'), [revoke('a-root')]);
      await refused(p('ops'), [revoke('s-dave')], 'protected_role');
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

  async function rbacDomainWithoutRoles(): Promise<RbacDomain> {
    return rbacDomain('bare', { without: ['roles'], admin: { backend: 'TestBackend', guard: GUARD }, model: table.model(), permissions: USER_PERMISSIONS });
  }
});
