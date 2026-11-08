import 'mocha';
import { expect } from 'chai';
import { unknownRouteMiddleware } from '../../src/doctor/rules/unknown-route-middleware.js';
import { fixture, service } from './fixture.js';

describe('CFG004 unknown-route-middleware', () => {
  const base = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
  const m = fixture({
    services: [
      service({ className: 'RouteTiming', registeredAs: ['RouteMiddleware', 'RouteTiming'] }),
      service({ className: 'AcceptsMiddleware', registeredAs: ['RouteMiddleware', 'AcceptsMiddleware'] }),
      service({ className: 'AccessLog', registeredAs: ['ServerMiddleware', 'AccessLog'] }),
    ],
  });
  const run = (middlewares: unknown) => unknownRouteMiddleware.run(m, { ...base, config: { http: { routes: { middlewares } } } });

  it('without config: reports nothing', () => {
    expect(unknownRouteMiddleware.run(m, base)).to.deep.equal([]);
  });

  it('accepts names and { service } entries of registered RouteMiddleware types', () => {
    expect(run(['RouteTiming', { service: 'AcceptsMiddleware', options: [1] }])).to.deep.equal([]);
  });

  it('reports an unknown name with the closest RouteMiddleware name', () => {
    expect(run(['RouteTimng'])).to.deep.equal([
      { code: 'CFG004', severity: 'error', message: "http.routes.middlewares[0] names 'RouteTimng', which no RouteMiddleware registers: did you mean 'RouteTiming'?" },
    ]);
  });

  it('reports an unknown { service } name, matching names with or without the Middleware suffix', () => {
    expect(run(['RouteTiming', { service: 'Accepts' }])).to.deep.equal([
      { code: 'CFG004', severity: 'error', message: "http.routes.middlewares[1] names 'Accepts', which no RouteMiddleware registers: did you mean 'AcceptsMiddleware'?" },
    ]);
  });

  it('does not count a type registered as another kind of middleware', () => {
    expect(run(['AccessLog'])).to.deep.equal([
      { code: 'CFG004', severity: 'error', message: "http.routes.middlewares[0] names 'AccessLog', which no RouteMiddleware registers. Registered: AcceptsMiddleware, RouteTiming" },
    ]);
  });

  it('suggests nothing when no name is close', () => {
    expect(run(['Gzip'])).to.deep.equal([
      { code: 'CFG004', severity: 'error', message: "http.routes.middlewares[0] names 'Gzip', which no RouteMiddleware registers. Registered: AcceptsMiddleware, RouteTiming" },
    ]);
  });

  it('skips entries it cannot name ( a class from a JS config ) and a value that is not a list', () => {
    expect(run([class RouteTiming {}, { options: [] }])).to.deep.equal([]);
    expect(run('RouteTiming')).to.deep.equal([]);
  });
});
