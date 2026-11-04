import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';
import { DecisionLog, DecisionTap, FALSE, TRUE } from '@spinajs/authz';
import type { Decision, DecisionRecord, ResourceRef } from '@spinajs/authz';
import { activateIn, domains, installHost, instance, resetHost, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const doc1: ResourceRef = { type: 'doc', id: '1' };

class RecordingTap extends DecisionTap {
  readonly decisions: Decision[] = [];

  onDecision(_req: unknown, decision: Decision): void {
    this.decisions.push(decision);
  }
}

class RecordingSink extends DecisionLog {
  readonly records: DecisionRecord[] = [];

  async write(records: DecisionRecord[]): Promise<void> {
    this.records.push(...records);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('DecisionTap registrations', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:read': {} });
  });

  it('reach the Authorizer of a domain whose container resolves them', async () => {
    const tap = new RecordingTap();
    const d = await domains();
    const c = d.create('job');
    activateIn(c, 'job', new StaticModel({ name: 'jm', votes: { '*': { permitWhen: TRUE } } }));
    c.register(instance(tap)).as(DecisionTap);
    const decision = await (await d.service('job')).check({ principal: alice, permission: 'doc:read', resource: doc1 });
    expect(decision.allowed).to.equal(true);
    expect(tap.decisions).to.deep.equal([decision]);
  });

  it("a registered DecisionLog logs the domain's denials ('deny' by default); none, or mode 'off', means no tap", async () => {
    setConfig('authz.decisionLog', { batch: { size: 1 } });
    const sink = new RecordingSink();
    const d = await domains();
    const c = d.create('job');
    activateIn(c, 'job', new StaticModel({ name: 'jm', votes: { '*': { permitWhen: FALSE } } }));
    c.register(instance(sink)).as(DecisionLog);
    const denied = await (await d.service('job')).check({ principal: alice, permission: 'doc:read', resource: doc1 });
    await tick();
    expect(denied.id).to.be.a('string');
    expect(sink.records.map((r) => [r.id, r.domain, r.allowed])).to.deep.equal([[denied.id, 'job', false]]);

    const bare = d.create('bare');
    activateIn(bare, 'bare', new StaticModel({ name: 'bm', votes: { '*': { permitWhen: FALSE } } }));
    expect(await (await d.service('bare')).check({ principal: alice, permission: 'doc:read', resource: doc1 })).to.not.have.property('id');
  });

  it("mode 'off' registers no tap even with a DecisionLog", async () => {
    setConfig('authz.decisionLog', { mode: 'off' });
    const sink = new RecordingSink();
    const d = await domains();
    const c = d.create('job');
    activateIn(c, 'job', new StaticModel({ name: 'jm', votes: { '*': { permitWhen: FALSE } } }));
    c.register(instance(sink)).as(DecisionLog);
    const denied = await (await d.service('job')).check({ principal: alice, permission: 'doc:read', resource: doc1 });
    await tick();
    expect(denied).to.not.have.property('id');
    expect(sink.records).to.deep.equal([]);
  });
});
