import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import { FALSE } from '../../../src/index.js';
import type { ResourceFilter } from '../../../src/index.js';
import { StaticModel, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');
const unsimplifiedFalse: ResourceFilter = { op: 'and', args: [FALSE, { op: 'cmp', field: 'a', cmp: 'eq', value: 1 }] };

describe('B01: no routed model permits', () => {
  for (const algorithm of ['deny-overrides', 'permit-overrides', 'first-applicable']) {
    it(`B01: an empty plan ⇒ no_access (${algorithm})`, async () => {
      const m = new StaticModel('m', { applies: () => false });
      const a = new Authorizer({ domain: 'root', models: [m], registry, combine: { default: { algorithm } } });
      const d = await a.check({ principal: alice, permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.residual).to.equal(FALSE);
      expect(d.reason).to.deep.equal({ code: 'no_access' });
      expect(m.calls).to.have.length(0);
    });

    it(`B01: all-FALSE votes ⇒ no_access (${algorithm})`, async () => {
      const models = [new StaticModel('a'), new StaticModel('b', { vote: { permitWhen: unsimplifiedFalse, denyWhen: unsimplifiedFalse } })];
      const a = new Authorizer({ domain: 'root', models, registry, combine: { default: { algorithm } } });
      const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
      expect(d.allowed).to.equal(false);
      expect(d.residual).to.equal(FALSE);
      expect(d.reason).to.deep.equal({ code: 'no_access' });
      expect(d.fields).to.deep.equal({ read: [], write: [] });
    });
  }

  it('B01: no models at all ⇒ no_access', async () => {
    const a = new Authorizer({ domain: 'root', models: [], registry });
    const d = await a.check({ principal: alice, permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'no_access' });
    expect(a.filterNow(alice, 'doc:read', 'doc')).to.equal(FALSE);
  });
});
