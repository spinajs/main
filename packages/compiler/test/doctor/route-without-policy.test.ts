import 'mocha';
import { expect } from 'chai';
import { routeWithoutPolicy } from '../../src/doctor/rules/route-without-policy.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('HTTP002 route-without-policy', () => {
  it('still reports a route only a registration serves: it is served when that registration runs', () => {
    const m = fixture({ controllers: [controller({ className: 'Registered', mountedBy: 'di', routes: [route({ handler: 'leak' })] })] });
    expect(routeWithoutPolicy.run(m, ctx).map((d) => d.code)).to.deep.equal(['HTTP002']);
  });

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
  it('reports an unguarded inherited route at the subclass, naming the base', () => {
    const m = fixture({ controllers: [controller({ className: 'AppUploads', source: src('src/controllers/uploads.ts', 3), routes: [route({ handler: 'create', inheritedFrom: '@spinajs/upload:UploadController', source: { file: 'src/http/upload-controller.ts', line: 70, col: 3, package: '@spinajs/upload' } })] })] });
    const [d] = routeWithoutPolicy.run(m, ctx);
    expect(d.message).to.equal('AppUploads.create (inherited from @spinajs/upload:UploadController) is a route with no @Access, @Policy, @AllowAnonymous or @Public on it or on its class.');
    expect(d.source).to.deep.equal(src('src/controllers/uploads.ts', 3));
  });

  it('is satisfied by a class guard the subclass inherits', () => {
    const m = fixture({ controllers: [controller({ className: 'Articles', policies: [[{ type: 'AccessPolicy', options: ['class'] }]], access: ['crud:use'], bases: ['app:BaseCrud'], routes: [route({ handler: 'get', inheritedFrom: 'app:BaseCrud' })] })] });
    expect(routeWithoutPolicy.run(m, ctx)).to.deep.equal([]);
  });
});
