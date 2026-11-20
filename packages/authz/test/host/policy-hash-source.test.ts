import * as chai from 'chai';
import 'mocha';
import { StaticModel, TestLog, userPrincipal } from '@spinajs/authz-testing';
import { AuthzService, DecisionLog, FALSE, PolicyHashSource } from '@spinajs/authz';
import type { DecisionRecord } from '@spinajs/authz';
import { activateIn, domains, installHost, instance, resetHost, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;
const alice = userPrincipal('alice');
const doc1 = { type: 'doc', id: 'd1' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

class Sink extends DecisionLog {
  readonly records: DecisionRecord[] = [];
  write(records: DecisionRecord[]) {
    this.records.push(...records);
    return Promise.resolve();
  }
}

class Source extends PolicyHashSource {
  readonly prepared: Array<{ domain: string; models: string[]; config: unknown; registry: boolean }> = [];
  fail = false;
  disposeWhilePreparing = false;
  private hashes = new Map<string, string>();
  policyHash(domain: string) {
    return this.hashes.get(domain);
  }
  async prepare(domain: string, service: AuthzService) {
    await tick();
    if (this.disposeWhilePreparing) await service.dispose();
    if (this.fail) throw new Error('compile failed');
    const [m] = service.models();
    const ctx = service.irContext!(m);
    this.prepared.push({ domain, models: service.models().map((x) => x.name), config: ctx.config('flag', 'none'), registry: ctx.permissions?.get('doc:read') !== undefined });
    this.hashes.set(domain, 'a'.repeat(64));
  }
}

describe('PolicyHashSource.prepare', function () {
  this.timeout(10000);
  before(() => installHost());
  after(() => uninstallHost());
  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:read': {} });
    setConfig('authz.decisionLog', { batch: { size: 1 } });
  });

  const boot = async (name: string, sink: Sink | undefined, source: Source) => {
    const d = await domains();
    const c = d.create(name);
    activateIn(c, name, new StaticModel({ name: 'jm', votes: { '*': { permitWhen: FALSE } } }));
    if (sink) c.register(instance(sink)).as(DecisionLog);
    c.register(instance(source)).as(PolicyHashSource);
    return d.service(name);
  };

  it('runs once before the service resolves, with the models, their config and the registry', async () => {
    setConfig('authz.jm', { flag: 'on' });
    const source = new Source();
    await boot('job', new Sink(), source);
    expect(source.prepared).to.deep.equal([{ domain: 'job', models: ['jm'], config: 'on', registry: true }]);
  });

  it('records the prepared hash in the decision records', async () => {
    const source = new Source();
    const sink = new Sink();
    await (await boot('job', sink, source)).check({ principal: alice, permission: 'doc:read', resource: doc1 });
    await tick();
    expect(sink.records.map((r) => r.policyHash)).to.deep.equal(['a'.repeat(64)]);
  });

  it('is not called for a domain without a decision log tap', async () => {
    const source = new Source();
    await boot('bare', undefined, source);
    expect(source.prepared).to.deep.equal([]);
  });

  it('a failing prepare is logged, the boot succeeds and records carry unknown', async () => {
    const source = new Source();
    source.fail = true;
    const sink = new Sink();
    await (await boot('job', sink, source)).check({ principal: alice, permission: 'doc:read', resource: doc1 });
    await tick();
    expect(sink.records.map((r) => r.policyHash)).to.deep.equal(['unknown']);
    expect(TestLog.messages('error')).to.include("Authz domain job: the policy hash source failed to prepare; decision records carry policyHash 'unknown'");
  });

  it('a service disposed while its policy is prepared does not resolve', async () => {
    const source = new Source();
    source.disposeWhilePreparing = true;
    const c = (await domains()).create('job');
    activateIn(c, 'job', new StaticModel({ name: 'jm', votes: {} }));
    c.register(instance(new Sink())).as(DecisionLog);
    c.register(instance(source)).as(PolicyHashSource);
    let error: unknown;
    // Through DI, not AuthzDomains.service(), which has its own disposed check.
    await c.resolve(AuthzService).catch((e: unknown) => (error = e));
    expect(String(error)).to.contain('was disposed while it booted');
  });
});
