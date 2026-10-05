import { GLOBAL } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP } from '../../src/index.js';
import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { RouteWorld, assignment, at, registerRouteSources, service, u, user } from './route-world.js';

/*
 * E3 hand-off (RFC E2-2): an intersect agent whose delegate's residual holds native:rbac.assignment (v1, and
 * args v2 with a threshold term beside it), listed through authz-orm's middleware on SQLite and Postgres: the
 * rows the agent's query returns are the rows its checks allow, and each such check is the delegate's AND the
 * agent's own.
 */

describe('authz-rbac orm-compile: an intersect agent through authz-orm (RFC E2-2)', function () {
  this.timeout(600000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_intersect');
    await (await testHost.domains()).service('root');
    undoSources = registerRouteSources();
  });

  after(async () => {
    undoSources?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: RouteWorld;

      before(async () => {
        world = await RouteWorld.open(db, kind);
      });

      after(async () => {
        await world?.close();
      });

      async function agrees(agent: Principal, delegate: Principal, alone: Principal, want: readonly string[], ops: readonly string[]): Promise<void> {
        const residual = await world.residual(agent, 'doc:read');
        const json = JSON.stringify(residual);
        for (const op of ops) expect(json, `${kind}: the agent's filter keeps ${op}`).to.include(op);
        expect(json, `${kind}: the kept term names the delegate`).to.include(`"id":"${delegate.id}"`);
        const allowed = await world.allowed(agent, 'doc:read');
        for (const id of await world.docIds()) {
          const check = async (p: Principal) => (await world.service.check({ principal: p, permission: 'doc:read', resource: { type: 'doc', id }, subject: await world.row(id) })).allowed;
          expect(allowed.includes(id), `${kind} doc ${id}: the agent's check vs the delegate's AND its own`).to.equal((await check(delegate)) && (await check(alone)));
        }
        expect(allowed, `${kind}: check()`).to.deep.equal([...want].sort());
        // doc:read runs the authz-orm middleware: the query as the agent.
        expect(await world.listed(agent, 'doc:read'), `${kind}: listed through the middleware, ${json}`).to.deep.equal(allowed);
      }

      it("the delegate's native:rbac.assignment (v1) is kept: the agent lists what its checks allow", async () => {
        await world.configure();
        await world.assign([assignment(u('u1'), 'team.lead', at('project', '10')), assignment(u('u1'), 'viewer', at('doc', '3')), assignment({ type: 'service', id: 's2' }, 'viewer', at('org', 'o1'))]);
        const u1 = user('u1');
        // s2's own: its config role team.lead implies editor below GLOBAL (every doc), and its viewer at o1.
        await agrees({ ...service('s2'), onBehalfOf: u1, delegation: 'intersect' } as Principal, u1, service('s2'), ['1', '2', '3', '7'], [RBAC_ASSIGNMENT_OP]);
      });

      it('with rules: the args v2 route and threshold terms are kept as well', async () => {
        await world.configure({ rules: [{ id: 't1', kind: 'threshold', scope: at('org', 'o1'), permissions: ['doc:read'], minRole: 'editor' }] });
        await world.assign([assignment(u('u1'), 'team.lead', at('project', '10')), assignment(u('u1'), 'viewer', at('doc', '3')), assignment(u('u1'), 'viewer', GLOBAL)]);
        const u1 = user('u1');
        // u1 reads every doc, but under o1 (docs 1 and 3) the threshold wants editor: doc 1 has it below project 10, doc 3 does not.
        await agrees({ ...service('s2'), onBehalfOf: u1, delegation: 'intersect' } as Principal, u1, service('s2'), ['1', '2', '4', '5', '6', '7', '8'], [RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP]);
      });
    });
  }
});
