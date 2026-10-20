import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { RecordingAudit, userPrincipal } from '@spinajs/authz-testing';

import { AuthzClock, AuthzConfigError, ChangeBus, DecisionAudit, InProcessChangeBus, LogDecisionAudit, SystemClock } from '@spinajs/authz';
import { domains, installHost, instance, resetHost, rootService, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');

class FixedClock extends AuthzClock {
  now(): Date {
    return new Date(1000);
  }
}

describe('DefaultAuthzDomains accessors', function () {
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

  it('refuse a domain whose service has not booted, and an unknown domain', async () => {
    const d = await domains();
    d.create('a');
    for (const get of ['config', 'audit', 'bus', 'clock'] as const) {
      expect(() => d[get]('a'), get).to.throw(AuthzConfigError, /"a" has no booted AuthzService/);
      expect(() => d[get]('nope'), get).to.throw(AuthzConfigError, /"nope" does not exist/);
    }
  });

  it('give the default bus, audit and clock the root service booted with', async () => {
    await rootService();
    const d = await domains();
    expect(d.bus('root')).to.equal(DI.RootContainer.get(InProcessChangeBus));
    expect(d.audit('root')).to.be.instanceOf(LogDecisionAudit);
    expect(d.clock('root')).to.be.instanceOf(SystemClock);
  });

  it('give the audit, bus and clock a child domain picked, by name where configured', async () => {
    class NamedAudit extends RecordingAudit {}
    class OtherAudit extends RecordingAudit {}
    class NamedBus extends InProcessChangeBus {}
    const clock = new FixedClock();
    setConfig(['authz', 'domains', 'a'], { audit: { service: 'NamedAudit' }, bus: { service: 'NamedBus' } });
    const d = await domains();
    const c = d.create('a');
    c.register(NamedAudit).as(DecisionAudit);
    c.register(OtherAudit).as(DecisionAudit);
    c.register(NamedBus).as(ChangeBus);
    c.register(instance(clock)).as(AuthzClock);
    const svc = await d.service('a');

    const audit = d.audit('a');
    expect(audit).to.be.instanceOf(NamedAudit);
    await svc.runAs(alice, 'audited', async () => undefined);
    expect((audit as NamedAudit).of('runAs')).to.have.length(1);
    expect(d.bus('a')).to.be.instanceOf(NamedBus);
    expect(d.clock('a')).to.equal(clock);
  });

  it('give the configuration merged over the lineage, frozen and computed once', async () => {
    setConfig(['authz', 'cache'], { ttlSeconds: 7 });
    setConfig(['authz', 'domains', 'p'], { audit: { runAs: false } });
    setConfig(['authz', 'domains', 'k'], { parent: 'p', cache: { maxEntries: 3 } });
    const d = await domains();
    d.create('p');
    d.create('k');
    await d.service('p');
    await d.service('k');

    const cfg = d.config('k');
    expect(cfg.domain).to.equal('k');
    expect(cfg.parent).to.equal('p');
    expect(cfg.cache).to.deep.equal({ maxEntries: 3, ttlSeconds: 7 });
    expect(cfg.audit.runAs).to.equal(false);
    expect(Object.isFrozen(cfg)).to.equal(true);
    expect(Object.isFrozen(cfg.cache)).to.equal(true);
    expect(d.config('k')).to.equal(cfg);

    setConfig(['authz', 'cache'], { ttlSeconds: 9 });
    expect(d.config('k').cache.ttlSeconds).to.equal(7);
  });

  it('forget what a service booted with once it is disposed', async () => {
    const d = await domains();
    const c = d.create('a');
    const svc = await d.service('a');
    expect(d.audit('a')).to.be.instanceOf(LogDecisionAudit);
    await svc.dispose();
    expect(() => d.audit('a')).to.throw(AuthzConfigError, /no booted AuthzService/);
    await c.dispose();
    expect(() => d.config('a')).to.throw(AuthzConfigError, /does not exist/);
  });
});
