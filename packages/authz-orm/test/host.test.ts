import * as chai from 'chai';
import 'mocha';

import { AuthzClock, DecisionAudit, SYSTEM, authzStorage, runWithPrincipal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { marksOf, setMarks } from '../src/marker.js';
import { auditUnscoped, domainConfig, domainContainer, domainNow, ormDomain, storageUnscoped } from '../src/host.js';

const expect = chai.expect;
const tick = () => new Promise((r) => setImmediate(r));

class NamedAudit extends RecordingAudit {
  static last: NamedAudit | undefined;

  constructor() {
    super();
    NamedAudit.last = this;
  }
}

const lastNamed = (): NamedAudit | undefined => NamedAudit.last;

describe('authz-orm host helpers', function () {
  this.timeout(30000);

  before(async () => {
    await testHost.installHost();
  });

  after(async () => {
    await testHost.uninstallHost();
  });

  afterEach(async () => {
    await testHost.resetHost();
  });

  it('ormDomain reads authz.orm.domain, default root', () => {
    expect(ormDomain()).to.equal('root');
    testHost.config().set(['authz', 'orm', 'domain'], 'app');
    expect(ormDomain()).to.equal('app');
  });

  it('domainContainer falls back to the DI root before the host created the domain', () => {
    expect(domainContainer('nope')).to.equal(DI.RootContainer);
  });

  it('marks live on the builder object, frozen, and are not enumerable', () => {
    const builder = {};
    expect(marksOf(builder)).to.equal(undefined);
    setMarks(builder, { unscoped: 'export' });
    expect(marksOf(builder)).to.deep.equal({ unscoped: 'export' });
    expect(Object.isFrozen(marksOf(builder))).to.equal(true);
    expect(Object.keys(builder)).to.deep.equal([]);
  });

  it('storageUnscoped reads the route @Unscoped reason of the request store', async () => {
    expect(storageUnscoped()).to.equal(undefined);
    await authzStorage().run({ Unscoped: 'report' } as never, async () => {
      expect(storageUnscoped()).to.equal('report');
    });
  });

  it('auditUnscoped records nothing when the booted domain has authz.audit.unscoped off', async () => {
    const audit = new RecordingAudit();
    testHost.registerInRoot(DecisionAudit, testHost.instance(audit));
    testHost.config().set(['authz', 'audit', 'unscoped'], false);
    await (await testHost.domains()).service('root');
    await runWithPrincipal(SYSTEM, async () => auditUnscoped('root', SYSTEM, 'off', 'task'));
    await tick();
    expect(audit.of('unscoped')).to.have.length(0);
  });

  it("after the boot, the audit helpers use the service's boot config and audit, not later changes", async () => {
    const audit = new RecordingAudit();
    testHost.registerInRoot(DecisionAudit, testHost.instance(audit));
    await (await testHost.domains()).service('root');
    testHost.config().set(['authz', 'audit', 'unscoped'], false);
    testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit()));
    expect(domainConfig('root').audit.unscoped).to.equal(true);
    auditUnscoped('root', SYSTEM, 'export', 'task');
    await tick();
    expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: SYSTEM.type, id: SYSTEM.id }, reason: 'export', resource: { type: 'task' } }]);
  });

  it('before the boot, the audit helpers read the configuration and pick the audit as the host does', async () => {
    NamedAudit.last = undefined;
    testHost.registerInRoot(DecisionAudit, NamedAudit);
    testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit()));
    testHost.config().set(['authz', 'audit', 'service'], 'NamedAudit');
    auditUnscoped('root', SYSTEM, 'export', 'task');
    await tick();
    expect(lastNamed()?.of('unscoped')).to.have.length(1);
    testHost.config().set(['authz', 'audit', 'unscoped'], false);
    expect(domainConfig('root').audit.unscoped).to.equal(false);
    auditUnscoped('root', SYSTEM, 'again', 'task');
    await tick();
    expect(lastNamed()?.of('unscoped')).to.have.length(1);
  });

  it("domainNow is the system time before the boot and the domain's clock after it", async () => {
    const fixed = new Date('2030-01-01T00:00:00Z');
    testHost.registerInRoot(AuthzClock, testHost.instance({ now: () => fixed }));
    const before = Date.now();
    const pre = domainNow('root').getTime();
    expect(pre).to.be.within(before, Date.now());
    await (await testHost.domains()).service('root');
    expect(domainNow('root')).to.equal(fixed);
  });
});
