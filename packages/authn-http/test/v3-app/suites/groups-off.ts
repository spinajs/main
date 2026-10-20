import { expect } from 'chai';
import { Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IController, IRoute, Request } from '@spinajs/http';
import { ImpersonationGuard, PrincipalFactory, RoleSource } from '@spinajs/authn/contracts';

import { ImpersonationGuardRegistered, RoleSourceRegistered } from '../../../src/v3/index.js';
import { Client, loggedIn, seedUser } from '../app.js';

export function groupsOffSuite(): void {
  it('without a RoleSource the role switch routes answer 404, also to a session', async () => {
    const anonymous = new Client();
    const session = await loggedIn(await seedUser());
    for (const c of [anonymous, session]) {
      expect((await c.get('/auth/active-role')).status).to.eq(404);
      expect((await c.post('/auth/active-role', { role: 'editor' })).status).to.eq(404);
    }
  });

  it('without an ImpersonationGuard the impersonation routes answer 404, also to a session', async () => {
    const anonymous = new Client();
    const session = await loggedIn(await seedUser());
    for (const c of [anonymous, session]) {
      expect((await c.get('/auth/impersonate')).status).to.eq(404);
      expect((await c.post('/auth/impersonate', { target: 'x' })).status).to.eq(404);
      expect((await c.del('/auth/impersonate')).status).to.eq(404);
    }
  });

  it('the group policies ask the container they resolve from, and stay closed until every service they need is there', async () => {
    const route = {} as IRoute;
    const ctrl = {} as IController;
    const req = { storage: {} } as unknown as Request;
    // The role switch builds the caller's principal, so it needs a PrincipalFactory beside the RoleSource.
    for (const [Policy, hooks] of [
      [RoleSourceRegistered, [RoleSource, PrincipalFactory]],
      [ImpersonationGuardRegistered, [ImpersonationGuard]],
    ] as const) {
      const p = new Policy();
      expect(p.isEnabled(route, ctrl)).to.eq(true);
      let container: IContainer = new Container();
      for (const Hook of hooks) {
        (p as unknown as { Container: unknown }).Container = container;
        await p.execute(req, route, ctrl).then(
          () => expect.fail(`${Policy.name} passed without a ${Hook.name}`),
          (e: { constructor: { name: string } }) => expect(e.constructor.name).to.eq('ResourceNotFound'),
        );
        container = container.child();
        container.register({ [`Stub${Hook.name}`]: () => ({}) }[`Stub${Hook.name}`]).as(Hook as never);
      }
      (p as unknown as { Container: unknown }).Container = container;
      await p.execute(req, route, ctrl);
    }
  });
}
