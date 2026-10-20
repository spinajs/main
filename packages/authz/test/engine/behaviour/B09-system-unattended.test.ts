import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import { FALSE, SYSTEM, TRUE, UNATTENDED } from '../../../src/index.js';
import type { Principal } from '../../../src/index.js';
import { RecordingAudit, StaticModel, deny, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);

const setup = (vote = permit()) => {
  const m = new StaticModel('m', { vote });
  const audit = new RecordingAudit();
  return { m, audit, a: new Authorizer({ domain: 'root', registry, models: [m], audit }) };
};

// Core part of B09: the HTTP, ORM and job bypasses are other lanes.
describe('B09: SYSTEM and UNATTENDED', () => {
  it('B09: SYSTEM (by identity) is allowed without models and audited on every check', async () => {
    const { a, m, audit } = setup(deny());
    for (let i = 0; i < 2; i++) {
      const d = await a.check({ principal: SYSTEM, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
      expect(d.allowed).to.equal(true);
      expect(d.residual).to.equal(TRUE);
      expect(d.principal).to.deep.equal({ type: 'system', id: 'system' });
    }
    expect(a.filterNow(SYSTEM, 'doc:read', 'doc')).to.equal(TRUE);
    expect(m.calls).to.have.length(0);
    expect(audit.kinds()).to.deep.equal(['system', 'system', 'system']);
    expect(audit.entries[0]).to.deep.equal({ kind: 'system', principal: { type: 'system', id: 'system' }, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
  });

  it('B09: UNATTENDED and a missing principal deny unattended without models; the denial is audited', async () => {
    const { a, m, audit } = setup();
    for (const p of [UNATTENDED, undefined, null]) {
      const d = await a.check({ principal: p as never, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.residual).to.equal(FALSE);
      expect(d.reason).to.deep.equal({ code: 'unattended' });
      expect(d.principal).to.deep.equal({ type: 'unattended', id: 'unattended' });
    }
    expect(await a.filter(UNATTENDED, 'doc:read', 'doc')).to.equal(FALSE);
    expect(m.calls).to.have.length(0);
    expect(audit.entries[0]).to.deep.equal({ kind: 'deny', principal: { type: 'unattended', id: 'unattended' }, permission: 'doc:read', resource: { type: 'doc' }, reason: 'unattended' });
  });

  it('B09: forged copies of SYSTEM or UNATTENDED are denied unattended, never allowed', async () => {
    const { a, m, audit } = setup();
    const forged: unknown[] = [{ ...SYSTEM }, Object.freeze({ ...SYSTEM }), principal('system', 'system'), principal('system', 'root'), { ...UNATTENDED }, principal('unattended', 'x')];
    for (const p of forged) {
      const d = await a.check({ principal: p as Principal, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'unattended' });
    }
    expect(m.calls).to.have.length(0);
    expect(audit.kinds().every((k) => k === 'deny')).to.equal(true);
  });

  it('B09: SYSTEM or UNATTENDED behind onBehalfOf never lends its power, under either delegation', async () => {
    const { a, m } = setup();
    for (const delegation of ['intersect', 'inherit'] as const) {
      for (const delegate of [SYSTEM, UNATTENDED]) {
        const d = await a.check({ principal: principal('agent', 'bot', { onBehalfOf: delegate, delegation }), permission: 'doc:read' });
        expect(d.allowed).to.equal(false);
        expect(d.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: delegate === SYSTEM ? 'system:system' : 'unattended:unattended' });
      }
    }
    expect(m.calls).to.have.length(0);
  });

  it('B09: a delegate denial is audited with the request principal', async () => {
    const { a, audit } = setup();
    await a.check({ principal: principal('agent', 'bot', { onBehalfOf: SYSTEM, delegation: 'inherit' }), permission: 'doc:read' });
    expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'agent', id: 'bot' }, permission: 'doc:read', resource: { type: 'doc' }, reason: 'delegate' }]);
  });
});
