import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzConfigError, TRUE } from '@spinajs/authz';
import type { ListPlanRequest, ListSupport, ModelListPlan } from '@spinajs/authz';
import { installHost, instance, registerInRoot, resetHost, rootService, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');

/** Plans one owner term for the principal. */
class PlanningModel extends StaticModel {
  listSupport(): ListSupport {
    return true;
  }

  async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
    return { kind: 'terms', permit: [{ op: 'test.owner', args: { id: req.principal.id } }], deny: [] };
  }
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('DefaultAuthzService: accessPlan, checkAll and boot rule 12', function () {
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

  it('accessPlan answers through the domain service', async () => {
    setConfig('authz.permissions', { 'doc:read': { list: true } });
    registerInRoot(AuthorizationModel, instance(new PlanningModel({ name: 'planner' })));
    const svc = await rootService();
    expect(await svc.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: [{ op: 'test.owner', args: { id: 'alice' } }], deny: [] });
  });

  it('accessPlan hands the caller env to the models', async () => {
    const seen: ListPlanRequest[] = [];
    class EnvModel extends PlanningModel {
      async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
        seen.push(req);
        return super.listPlan(req);
      }
    }
    setConfig('authz.permissions', { 'doc:read': { list: true } });
    registerInRoot(AuthorizationModel, instance(new EnvModel({ name: 'planner' })));
    const svc = await rootService();
    await svc.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.1' });
    expect(seen[0].env?.ip).to.equal('10.0.0.1');
    expect(seen[0].env?.now).to.be.instanceOf(Date);
  });

  it('boot refuses a list permission routed to a model that cannot plan it', async () => {
    setConfig('authz.permissions', { 'doc:read': { list: true } });
    registerInRoot(AuthorizationModel, instance(new StaticModel({ name: 'plain' })));
    const err = await rejection(rootService());
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.contain('[6.5/12] domain "root", type "doc", permission "doc:read", model "plain": cannot plan lists: it has no listSupport()');
  });

  it('checkAll answers each request in input order', async () => {
    setConfig('authz.permissions', { 'doc:read': {}, 'doc:write': {} });
    registerInRoot(AuthorizationModel, instance(new StaticModel({ name: 'reader', votes: (req) => (req.permission === 'doc:read' ? { permitWhen: TRUE } : {}) })));
    const svc = await rootService();
    const doc = { type: 'doc', id: '1' };
    const out = await svc.checkAll(alice, [
      { permission: 'doc:write', resource: doc },
      { permission: 'doc:read', resource: doc },
    ]);
    expect(out.map((d) => [d.permission, d.allowed])).to.deep.equal([
      ['doc:write', false],
      ['doc:read', true],
    ]);
  });
});
