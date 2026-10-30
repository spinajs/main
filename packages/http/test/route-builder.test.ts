import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildRoutePath, createActionHandler, resolveRoutePolicies } from '../src/route-builder.js';
import { Ok } from '../src/response-methods/ok.js';
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

    // The manifest computes `fullPath` with the same function; these rows pin what http mounts, slashes included.
    const table: [string, string | undefined, string, string][] = [
      ['users', undefined, 'list', '/users/list'],
      ['users', '', 'emptyString', '/users/emptyString'],
      ['users', '/', 'root', '/users'],
      ['users', ':id', 'get', '/users/:id'],
      ['users', '/slash', 'leadingSlash', '/users//slash'],
      ['api/v2/things', undefined, 'all', '/api/v2/things/all'],
      ['api/v2/things', '/', 'index', '/api/v2/things'],
      ['nobasecontroller', undefined, 'pong', '/nobasecontroller/pong'],
      ['/', 'health', 'health', '/health'],
      ['/', undefined, 'bare', '///bare'],
      ['/', '/', 'slash', '//'],
      ['/lead', 'x', 'x', '//lead/x'],
    ];
    for (const [basePath, path, method, served] of table) {
      it(`mounts ${JSON.stringify(basePath)} + ${JSON.stringify(path)} on ${method}() at ${served}`, () => {
        expect(buildRoutePath(basePath, route({ Path: path, Method: method }))).to.eq(served);
        expect(buildRoutePath(basePath, route({ Path: path, Method: method }), 'api')).to.eq(`/api${served}`);
      });
    }
  });

  describe('resolveRoutePolicies', () => {
    it('throws RouteRegistrationException when string policy is not resolvable from config', async () => {
      const descriptor = { Policies: [[{ Type: 'http.some.policy.key', Options: [] }]], Middlewares: [] } as unknown as IControllerDescriptor;
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

  describe('createActionHandler', () => {
    it('waits for every async onResponse() before handing the response on', async () => {
      const calls: string[] = [];
      const controller = { action: async () => new Ok() } as any;
      const middleware = {
        onResponse: async () => {
          await new Promise((r) => setTimeout(r, 5));
          calls.push('onResponse');
        },
      } as any;

      const handler = createActionHandler(controller, route({ Method: 'action', Parameters: new Map() }), [middleware], new AsyncLocalStorage());

      await new Promise<void>((resolve) => {
        handler({ storage: {} } as any, { locals: {} } as any, () => {
          calls.push('next');
          resolve();
        });
      });

      expect(calls).to.deep.eq(['onResponse', 'next']);
    });
  });
});
