import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AdminGuard, PermissionRegistry, TRUE, principalKey } from '@spinajs/authz';
import type { AuthzCommand, HostLog, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { AccountStatusSource, DefaultAdminGuard } from '../../src/index.js';
import type { Assignment, AssignmentSubject, RoleDef } from '../../src/index.js';
import { G, P1, StaticRoleStore, failure, installHost, instance, ok, permissionRegistry, rbacDomain, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
const ROLES: RoleDef[] = [role('admin', { grants: [{ permission: 'users:update' }] }), role('ops', { grants: [{ permission: 'authz:assignments.manage' }] }), role('editor'), role('staff.set', { subjectSet: true })];
const USER_PERMISSIONS = { 'users:update': {} };

const user = (id: string): PrincipalRef => ({ type: 'user', id });
const row = (id: string, subject: AssignmentSubject, r: string, scope: ResourceRef = G): Assignment => ({ id, subject, role: r, scope, tags: [], expiresAt: null, source: 'test' });
const BASE: Assignment[] = [row('a-root', user('root'), 'admin'), row('a-root2', user('root2'), 'admin'), row('o-ops', user('ops'), 'ops'), row('e-erin', user('erin'), 'editor')];
const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });
const ops = userPrincipal('ops');

/** Answers from a table of principal keys; records every call. */
class FakeAccountStatus extends AccountStatusSource {
  readonly calls: (readonly PrincipalRef[])[] = [];

  constructor(private readonly answer: (refs: readonly PrincipalRef[]) => ReadonlyMap<string, boolean>) {
    super();
  }

  async inService(refs: readonly PrincipalRef[]): Promise<ReadonlyMap<string, boolean>> {
    this.calls.push(refs);
    return this.answer(refs);
  }
}

const answering = (states: Record<string, boolean>) => new FakeAccountStatus((refs) => new Map(refs.filter((r) => principalKey(r) in states).map((r) => [principalKey(r), states[principalKey(r)]])));

const warnings: string[] = [];

/** DefaultAdminGuard with its warnings recorded. */
class RecordingGuard extends DefaultAdminGuard {
  protected override log: HostLog = { error: () => undefined, warn: (m: string) => void warnings.push(m), info: () => undefined, debug: () => undefined };
}

const GUARD = { service: 'RecordingGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true };

describe('DefaultAdminGuard: last_holder counts only accounts in service', function () {
  this.timeout(20000);
  let d: RbacDomain;

  async function world(opts: { rows?: readonly Assignment[]; source?: AccountStatusSource } = {}): Promise<RbacDomain> {
    await resetHost();
    warnings.length = 0;
    d = await rbacDomain('test', {
      roleStores: [new StaticRoleStore('guard', ROLES)],
      assignments: opts.rows ?? BASE,
      admin: { backend: 'TestBackend', guard: GUARD },
      model: new StaticModel({ name: 'ops', votes: (req) => (req.principal.id === 'ops' && req.permission === 'authz:assignments.manage' ? { permitWhen: TRUE } : {}) }),
      permissions: USER_PERMISSIONS,
      register: (c) => {
        c.register(instance(permissionRegistry(USER_PERMISSIONS))).as(PermissionRegistry);
        c.register(RecordingGuard).as(AdminGuard);
        if (opts.source) c.register(instance(opts.source)).as(AccountStatusSource);
      },
    });
    return d;
  }

  const code = async (commands: AuthzCommand[]): Promise<string> => {
    const results = await d.admin.execute(ops, commands);
    return results.every((r) => r.ok) ? 'ok' : failure(results).code;
  };

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  it('a remaining holder the source reports out of service (banned) does not count', async () => {
    await world({ source: answering({ 'user:root': true, 'user:root2': false }) });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
    expect(await d.assignments.byId('a-root')).to.not.equal(null);
  });

  it('a remaining holder in service counts; the source is asked once, for the remaining sure holders', async () => {
    const source = answering({ 'user:root2': true });
    await world({ rows: [...BASE, row('a-root2-p', user('root2'), 'admin', P1)], source });
    expect(await code([revoke('a-root')])).to.equal('ok');
    expect(source.calls).to.deep.equal([[user('root2')]]);
  });

  it('a holder is asked about once per guard call, however many paths it has', async () => {
    const source = answering({ 'user:root2': true });
    await world({ rows: [...BASE, row('s-root2', user('root2'), 'staff.set'), row('set-admin', { set: { role: 'staff.set', scope: G } }, 'admin')], source });
    expect(await code([revoke('a-root')])).to.equal('ok');
    expect(source.calls).to.deep.equal([[user('root2')]]);
  });

  it('a holder through a subject set is judged by its own account', async () => {
    await world({ rows: [row('a-root', user('root'), 'admin'), row('o-ops', user('ops'), 'ops'), row('s-dave', user('dave'), 'staff.set'), row('set-admin', { set: { role: 'staff.set', scope: G } }, 'admin')], source: answering({ 'user:dave': false }) });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
  });

  it('a source that throws counts nobody: refused', async () => {
    const source = new FakeAccountStatus(() => {
      throw new Error('users table down');
    });
    await world({ source });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
    expect(source.calls).to.have.length(1);
  });

  it('a ref the source leaves out does not count: refused', async () => {
    await world({ source: answering({}) });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
  });

  it('a non-user principal goes to the source too, which decides', async () => {
    const svc: PrincipalRef = { type: 'service', id: 'backup' };
    const rows = [row('a-root', user('root'), 'admin'), row('a-svc', svc, 'admin'), row('o-ops', user('ops'), 'ops')];
    const source = answering({ 'service:backup': true });
    await world({ rows, source });
    expect(await code([revoke('a-root')])).to.equal('ok');
    expect(source.calls).to.deep.equal([[svc]]);
    await world({ rows, source: answering({ 'service:backup': false }) });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
  });

  it('the source is not asked when no removal lies on a path to privilegedPermission', async () => {
    const source = answering({});
    await world({ source });
    expect(await code([revoke('e-erin')])).to.equal('ok');
    expect(source.calls).to.deep.equal([]);
  });

  it('the source is not asked when no sure holder remains', async () => {
    const source = answering({ 'user:root2': true });
    await world({ source });
    expect(await code([revoke('a-root'), revoke('a-root2')])).to.equal('last_holder');
    expect(source.calls).to.have.length(1);
  });

  it('no source registered: holders count as before, and the guard warns once', async () => {
    await world({ rows: [...BASE, row('a-root3', user('root3'), 'admin')] });
    expect(await code([revoke('a-root')])).to.equal('ok');
    expect(await code([revoke('e-erin')])).to.equal('ok');
    expect(await code([revoke('a-root2')])).to.equal('ok');
    expect(await code([revoke('a-root3')])).to.equal('last_holder');
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include('AccountStatusSource');
  });

  it('a revoke that fails last_holder commits nothing of its batch', async () => {
    await world({ source: answering({ 'user:root2': false }) });
    const results = await d.admin.execute(ops, [revoke('e-erin'), revoke('a-root')]);
    expect(failure(results)).to.deep.equal({ at: 1, code: 'last_holder', field: 'id' });
    expect(await d.assignments.byId('e-erin')).to.not.equal(null);
    ok(await d.admin.execute(ops, [revoke('e-erin')]));
  });
});
