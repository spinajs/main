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

/** Cannot be built, so resolving the source throws. */
class UnresolvableAccountStatus extends AccountStatusSource {
  constructor() {
    super();
    throw new Error('users module failed to start');
  }

  async inService(): Promise<ReadonlyMap<string, boolean>> {
    return new Map();
  }
}

/** A source that breaks its contract: the answer is cast past the type checker, as plain JS could send it. */
const malformed = (answer: (refs: readonly PrincipalRef[]) => unknown) => new FakeAccountStatus((refs) => answer(refs) as ReadonlyMap<string, boolean>);

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

  async function world(opts: { rows?: readonly Assignment[]; source?: AccountStatusSource | (new () => AccountStatusSource) } = {}): Promise<RbacDomain> {
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
        if (typeof opts.source === 'function') c.register(opts.source).as(AccountStatusSource);
        else if (opts.source) c.register(instance(opts.source)).as(AccountStatusSource);
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

  it('a source failure is logged once per guard call, with the error name and message but no stack', async () => {
    await world({
      source: new FakeAccountStatus(() => {
        throw new RangeError('users table down');
      }),
    });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include('RangeError: users table down');
    expect(warnings[0]).to.not.include('guard-account-status');
    expect(await code([revoke('a-root')])).to.equal('last_holder');
    expect(warnings).to.have.length(2);
  });

  for (const value of [1, 'yes', 'true', {}]) {
    it(`an answer that is not exactly true (${JSON.stringify(value)}) does not count: refused`, async () => {
      await world({ source: malformed((refs) => new Map(refs.map((r) => [principalKey(r), value]))) });
      expect(await code([revoke('a-root')])).to.equal('last_holder');
    });
  }

  it('an answer that is not a Map counts nobody: refused', async () => {
    await world({ source: malformed(() => ({ 'user:root2': true })) });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
    expect(warnings).to.have.length(1);
  });

  it('a source that cannot be resolved counts nobody: refused', async () => {
    await world({ source: UnresolvableAccountStatus });
    expect(await code([revoke('a-root')])).to.equal('last_holder');
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include('users module failed to start');
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
