import 'mocha';
import { expect } from 'chai';
import { buildRoutePath, resolveRoutePolicies } from '../src/route-builder.js';
import { RouteRegistrationException } from '../src/exceptions.js';
import type { IControllerDescriptor, IRoute } from '../src/interfaces.js';

const route = (partial: Partial<IRoute>): IRoute => partial as IRoute;

describe('route-builder', () => {
  describe('buildRoutePath', () => {
    it('builds base path for route path "/"', () => {
      expect(buildRoutePath('user', route({ Path: '/' }))).to.eq('/user');
    });

    it('joins base and route path', () => {
      expect(buildRoutePath('user', route({ Path: 'grants' }))).to.eq('/user/grants');
    });

    it('handles basePath "/"', () => {
      expect(buildRoutePath('/', route({ Path: 'grants' }))).to.eq('/grants');
    });

    it('falls back to method name when route has no path', () => {
      expect(buildRoutePath('user', route({ Method: 'refresh' }))).to.eq('/user/refresh');
    });

    it('prepends global prefix', () => {
      expect(buildRoutePath('user', route({ Path: 'grants' }), 'api/v1')).to.eq('/api/v1/user/grants');
    });

    it('ignores empty global prefix', () => {
      expect(buildRoutePath('user', route({ Path: 'grants' }), undefined)).to.eq('/user/grants');
    });
  });

  describe('resolveRoutePolicies', () => {
    it('throws RouteRegistrationException when string policy is not resolvable from config', async () => {
      const descriptor = { Policies: [{ Type: 'http.some.policy.key', Options: [] }], Middlewares: [] } as unknown as IControllerDescriptor;
      const r = route({ Method: 'refresh', Path: 'refresh', Policies: [] });

      const fakeCfg = { get: () => undefined } as any;
      const fakeContainer = { resolve: () => Promise.resolve(null) } as any;
      const fakeLog = { warn: () => {}, trace: () => {} } as any;

      try {
        await resolveRoutePolicies(descriptor, r, fakeContainer, fakeCfg, fakeLog, 'TestController', '/test/refresh');
        expect.fail('expected RouteRegistrationException');
      } catch (err) {
        expect(err).to.be.instanceOf(RouteRegistrationException);
        expect((err as Error).message).to.contain('http.some.policy.key');
        expect((err as Error).message).to.contain('TestController');
      }
    });
  });
});
