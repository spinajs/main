import 'mocha';
import { expect } from 'chai';

import type { ListPlanRequest } from '@spinajs/authz';

import { ListStaticModel, StaticModel, fixtureDsl, instantiateWorld, toPermissionDef, userPrincipal } from '../src/index.js';

const { allRows, combine, noRows, ownedRows, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');
const read = toPermissionDef({ name: 'task:read', list: true });
const update = toPermissionDef('task:update');

describe('ListStaticModel', () => {
  const model = new ListStaticModel({ name: 'm1', lists: { 'task:read': ownedRows() } });

  it('supports exactly the permissions it has a plan for', () => {
    expect(model.listSupport(read, 'task')).to.equal(true);
    expect(model.listSupport(update, 'task')).to.deep.equal({ reason: "static model m1 has no list plan for 'task:update'" });
  });

  it('answers the scripted plan for the principal and records the call', async () => {
    const req: ListPlanRequest = { principal: alice, permission: read, type: 'task' };
    expect(await model.listPlan(req, {} as never)).to.deep.equal({ kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [{ type: 'user', id: 'alice' }] } }], deny: [] });
    expect(model.calls.filter((c) => c.method === 'listPlan').map((c) => c.args[0])).to.deep.equal([req]);
  });

  it('has the constant plans of the DSL', () => {
    expect(allRows()).to.deep.equal({ kind: 'all' });
    expect(noRows()).to.deep.equal({ kind: 'deny-all', reason: { code: 'no_access' } });
  });

  it('instantiateWorld builds it only for a static spec with lists', () => {
    const world = { permissions: [{ name: 'task:read', list: true }], combine: combine('deny-overrides', 'a', 'b'), models: [staticModel('a', { lists: { 'task:read': allRows() } }), staticModel('b')] };
    const kit = instantiateWorld(world);
    const [a, b] = kit.models;
    expect(a).to.be.instanceOf(ListStaticModel);
    expect(b).to.be.instanceOf(StaticModel);
    expect(b).to.not.be.instanceOf(ListStaticModel);
    expect((b as unknown as { listSupport?: unknown }).listSupport).to.equal(undefined);
  });
});
