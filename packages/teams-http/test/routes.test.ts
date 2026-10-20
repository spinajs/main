import 'mocha';
import { expect } from 'chai';
import { IsAuthenticated, swaggerAccess } from '@spinajs/authz-http';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import { TEAMS_HTTP_CONTROLLERS, TEAMS_HTTP_ROUTES } from '../src/controller-list.js';

const AUTHENTICATED_ONLY = ['POST /invitations/accept', 'GET /user/teams'];

function routes() {
  return TEAMS_HTTP_CONTROLLERS.flatMap((controller) => {
    const d = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor;
    return [...d.Routes.entries()].map(([method, route]) => {
      const path = `/${d.BasePath}/${route.Path ?? ''}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      return { controller, method: method as string, route, key: `${String(route.Type).toUpperCase()} ${path}` };
    });
  });
}

describe('teams-http routes', () => {
  it('mounts exactly the routes of teams §9 and the restore route', () => {
    expect(routes().map((r) => r.key)).to.have.members([...TEAMS_HTTP_ROUTES]);
    expect(routes()).to.have.length(TEAMS_HTTP_ROUTES.length);
  });

  it('guards every route with @Access, except the two that check authentication only', () => {
    for (const r of routes()) {
      const access = swaggerAccess(r.controller, r.method);
      if (AUTHENTICATED_ONLY.includes(r.key)) {
        expect(access, r.key).to.eq(undefined);
        expect(r.route.Policies.some((group) => group.some((p) => p.Type === IsAuthenticated)), r.key).to.eq(true);
      } else {
        expect(access?.['x-authz-permission'], r.key).to.be.an('array').that.is.not.empty;
      }
    }
  });

  it('lets no route through anonymously', () => {
    for (const r of routes()) expect(swaggerAccess(r.controller, r.method)?.['x-authz-anonymous'], r.key).to.eq(undefined);
  });
});
