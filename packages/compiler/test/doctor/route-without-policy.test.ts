import 'mocha';
import { expect } from 'chai';
import { routeWithoutPolicy } from '../../src/doctor/rules/route-without-policy.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('HTTP002 route-without-policy', () => {
  it('reports a route with no guard on it or on its class', () => {
    const m = fixture({
      controllers: [
        controller({ className: 'Open', routes: [route({ handler: 'leak', source: src('src/open.ts', 5) }), route({ handler: 'anon', allowAnonymous: true }), route({ handler: 'open', public: 'login' }), route({ handler: 'acc', access: ['x:read'] }), route({ handler: 'pol', policies: [[{ type: 'AuthPolicy' }]] })] }),
        controller({ className: 'Guarded', policies: [[{ type: 'AuthPolicy' }]], routes: [route({ handler: 'fine' })] }),
        controller({ className: 'Public', allowAnonymous: true, routes: [route({ handler: 'fine' })] }),
        controller({ className: 'PublicClass', public: 'health checks', routes: [route({ handler: 'fine' })] }),
        controller({ className: 'Classed', access: ['x:read'], routes: [route({ handler: 'fine' })] }),
      ],
    });
    expect(routeWithoutPolicy.run(m, ctx)).to.deep.equal([
      { code: 'HTTP002', severity: 'error', message: 'Open.leak is a route with no @Access, @Policy, @AllowAnonymous or @Public on it or on its class.', source: src('src/open.ts', 5) },
    ]);
  });
});
