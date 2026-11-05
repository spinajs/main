import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';
import { DecisionTap, TRUE } from '@spinajs/authz';
import type { Decision, ResourceRef } from '@spinajs/authz';
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
});
