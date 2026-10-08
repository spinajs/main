import 'mocha';
import { expect } from 'chai';

import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, RouteType } from '@spinajs/http';

import { AuthzAdminController } from '../src/controllers/AuthzAdminController.js';

describe('AuthzAdmin routes: http verbs', () => {
  const READ_ONLY_ROUTES = ['listAssignments', 'listLinks', 'listRules', 'listPolicies', 'attributes'];

  const routes = () => [...(Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, new AuthzAdminController()) as IControllerDescriptor).Routes.values()];

  it('declares routes', () => {
    expect(routes().length).to.be.greaterThan(0);
  });

  it('no state-changing route answers GET', () => {
    const offenders = routes()
      .filter((r) => r.Type === RouteType.GET && !READ_ONLY_ROUTES.includes(String(r.Method)))
      .map((r) => String(r.Method));

    expect(offenders, 'a write over GET is triggerable by a link or a prefetch').to.deep.eq([]);
  });

  it('every read-only name is a real GET route', () => {
    const gets = routes().filter((r) => r.Type === RouteType.GET).map((r) => String(r.Method));

    expect(gets.sort()).to.deep.eq([...READ_ONLY_ROUTES].sort());
  });
});
