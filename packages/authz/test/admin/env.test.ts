import * as chai from 'chai';
import 'mocha';
import { NewInstance } from '@spinajs/di';
import { ManualClock, RecordingAudit, RecordingChangeBus, userPrincipal } from '@spinajs/authz-testing';

import { AdminGuard, AuthzClock, AuthzConfigError, ChangeBus, DecisionAudit } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';
import { FakeGuard, adminConfig, adminDomain, domains, installHost, instance, rejection, resetHost, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const grant = (subject: string): AuthzCommand => ({ kind: 'assignment.grant', subject: { type: 'user', id: subject }, role: 'editor', scope: { type: 'project', id: 'p1' } });

let built = 0;

@NewInstance()
class CountingGuard extends FakeGuard {
  constructor() {
    super();
    built++;
  }
}

describe('DefaultAuthzAdmin environment', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    built = 0;
  });

  it('is built once, by concurrent first calls too', async () => {
    adminConfig({ guard: { service: 'CountingGuard' } });
    const d = await adminDomain('test', { register: (c) => c.register(CountingGuard).as(AdminGuard) });
    await Promise.all([d.admin.execute(alice, [grant('bob')]), d.admin.execute(alice, [grant('carol')]), d.admin.list(alice, { kind: 'assignments' }).catch(() => undefined)]);
    await d.admin.execute(alice, [grant('dave')]);
    expect(built).to.equal(1);
    expect(d.store.rows.size).to.equal(3);
  });

  it('keeps the configuration of its first use', async () => {
    adminConfig({ maxBatch: 2 });
    const d = await adminDomain();
    expect((await d.admin.execute(alice, [grant('bob'), grant('carol')])).every((r) => r.ok)).to.equal(true);
    adminConfig({ maxBatch: 1 });
    expect((await d.admin.execute(alice, [grant('dave'), grant('erin')])).every((r) => r.ok)).to.equal(true);
  });

  it('builds again after a failed build', async () => {
    setConfig(['authz', 'admin'], { backend: 'TestBackend' });
    const d = await adminDomain();
    expect(await rejection(d.admin.execute(alice, [grant('bob')]))).to.be.instanceOf(AuthzConfigError);
    adminConfig();
    expect((await d.admin.execute(alice, [grant('bob')]))[0].ok).to.equal(true);
  });

  it('publishes, audits and dates with what the domain service booted with', async () => {
    adminConfig();
    const d = await adminDomain();
    const ds = await domains();
    expect(ds.bus('test')).to.equal(d.bus);
    expect(ds.audit('test')).to.equal(d.audit);
    expect(ds.clock('test')).to.equal(d.clock);

    // Registered after the boot: the admin keeps the service's picks.
    const lateBus = new RecordingChangeBus();
    const lateAudit = new RecordingAudit();
    d.container.register(instance(lateBus)).as(ChangeBus);
    d.container.register(instance(lateAudit)).as(DecisionAudit);
    d.container.register(instance(new ManualClock(new Date(0)))).as(AuthzClock);
    await d.admin.execute(alice, [grant('bob')]);

    expect(d.bus.published).to.have.length(1);
    expect(d.bus.published[0].at.getTime()).to.equal(d.clock.now().getTime());
    expect(d.audit.entries.filter((e) => e.kind === 'admin')).to.have.length(1);
    expect(lateBus.published).to.deep.equal([]);
    expect(lateAudit.entries).to.deep.equal([]);
  });

  it('takes the named bus and audit the domain configures', async () => {
    class NamedBus extends RecordingChangeBus {}
    class NamedAudit extends RecordingAudit {}
    adminConfig();
    const d = await adminDomain('test', {
      register(c) {
        c.register(NamedBus).as(ChangeBus);
        c.register(NamedAudit).as(DecisionAudit);
        setConfig(['authz', 'domains', 'test', 'bus'], { service: 'NamedBus' });
        setConfig(['authz', 'domains', 'test', 'audit'], { service: 'NamedAudit' });
      },
    });
    await d.admin.execute(alice, [grant('bob')]);
    const ds = await domains();
    const bus = ds.bus('test') as NamedBus;
    const audit = ds.audit('test') as NamedAudit;
    expect(bus).to.be.instanceOf(NamedBus);
    expect(audit).to.be.instanceOf(NamedAudit);
    expect(bus.published).to.have.length(1);
    expect(audit.entries.filter((e) => e.kind === 'admin')).to.have.length(1);
    expect(d.bus.published).to.deep.equal([]);
  });
});
