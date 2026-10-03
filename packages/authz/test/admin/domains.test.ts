import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzConfigError, AuthzService, AuthzWriteHandler, DefaultAuthzAdmin } from '@spinajs/authz';
import type { AdminCallContext, AuthzCommand } from '@spinajs/authz';
import { FakeAssignmentHandler, adminConfig, adminDomain, installHost, rejection, resetHost, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const grant = (subject: string): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: subject }, role: 'editor', scope: { type: 'project', id: 'p1' } });

class OtherHandler extends FakeAssignmentHandler {}

describe('DefaultAuthzAdmin per domain', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  describe('the guard fails closed', () => {
    it('rejects every call when authz.admin.guard.service is absent, and boot is untouched', async () => {
      setConfig(['authz', 'admin'], { backend: 'TestBackend' });
      const d = await adminDomain();
      expect(d.admin).to.be.instanceOf(DefaultAuthzAdmin);
      for (const batch of [[grant('bob')], []]) {
        const err = await rejection(d.admin.execute(alice, batch));
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.match(/authz\.admin\.guard\.service/);
      }
      expect(d.store.trace).to.deep.equal([]);
      expect(d.store.rows.size).to.equal(0);
    });

    it('rejects every call when no AdminGuard class has the configured name', async () => {
      setConfig(['authz', 'admin'], { backend: 'TestBackend', guard: { service: 'NoSuchGuard' } });
      const d = await adminDomain();
      const err = await rejection(d.admin.execute(alice, [grant('bob')]));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message)
        .to.match(/authz\.admin\.guard\.service/)
        .and.match(/NoSuchGuard/);
      expect(d.store.trace).to.deep.equal([]);
    });
  });

  it('gives every domain its own admin, bound to that domain', async () => {
    adminConfig();
    const a = await adminDomain('a');
    const b = await adminDomain('b');
    expect(a.admin).to.be.instanceOf(DefaultAuthzAdmin);
    expect(b.admin).to.be.instanceOf(DefaultAuthzAdmin);
    expect(a.admin).to.not.equal(b.admin);
    await a.admin.execute(alice, [grant('bob')]);
    expect(a.store.rows.size).to.equal(1);
    expect(b.store.rows.size).to.equal(0);
    expect(a.bus.published.map((c) => c.domain)).to.deep.equal(['a']);
    expect(b.bus.published).to.deep.equal([]);
    expect(a.sink.events.map((e) => e.domain)).to.deep.equal(['a']);
    expect((a.store.contexts[0] as AdminCallContext).authz).to.equal(a.service);
    expect(a.backend.version('a')).to.equal(1);
    expect(b.backend.version('b')).to.equal(0);
  });

  it('gives root a DefaultAuthzAdmin', async () => {
    const root = (await DI.resolve(AuthzService)) as AuthzService;
    expect(root.admin()).to.be.instanceOf(DefaultAuthzAdmin);
  });

  it('uses the MemoryAuthzAdminBackend when authz.admin.backend is absent', async () => {
    setConfig(['authz', 'admin'], { guard: { service: 'FakeGuard' } });
    const d = await adminDomain('plain', { backend: false });
    const before = d.backend.version('plain');
    expect(await d.admin.execute(alice, [grant('bob')])).to.have.length(1);
    expect(d.backend.version('plain')).to.equal(before + 1);
    expect(d.store.rows.size).to.equal(1);
  });

  it('rejects when authz.admin.backend names no registered class', async () => {
    adminConfig({ backend: 'NoSuchBackend' });
    const d = await adminDomain();
    const err = await rejection(d.admin.execute(alice, [grant('bob')]));
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.match(/authz\.admin\.backend/);
  });

  it('rejects when two handlers claim one kind', async () => {
    adminConfig();
    const d = await adminDomain('test', { register: (c) => c.register(OtherHandler).as(AuthzWriteHandler) });
    const err = await rejection(d.admin.execute(alice, [grant('bob')]));
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.match(/assignment\.grant/);
  });

  it('reports not_found for every kind when no handler is registered', async () => {
    adminConfig();
    const d = await adminDomain('test', { handlers: false });
    const out = await d.admin.execute(alice, [grant('bob')]);
    expect(out[0].ok).to.equal(false);
    expect((out[0] as { error: { code: string } }).error.code).to.equal('not_found');
  });
});
