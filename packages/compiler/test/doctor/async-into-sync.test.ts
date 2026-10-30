import 'mocha';
import { expect } from 'chai';
import { asyncIntoSync } from '../../src/doctor/rules/async-into-sync.js';
import { fixture, service, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('DI003 async-into-sync', () => {
  it('reports a sync service injecting an async provider as an error when it also resolves synchronously', () => {
    const m = fixture({
      services: [
        service({ className: 'AuthzService', async: true, registeredAs: ['AuthzService'] }),
        service({
          className: 'SyncGuard', async: false, propertyInjects: [{ property: 'authz', token: 'AuthzService', optional: false, array: false }], source: src('src/guard.ts', 7),
          imperativeResolves: [{ token: 'Other', method: 'run', awaited: false, source: src('src/guard.ts', 12) }],
        }),
      ],
    });
    expect(asyncIntoSync.run(m, ctx)).to.deep.equal([
      { code: 'DI003', severity: 'error', message: 'SyncGuard is synchronous but injects asynchronous AuthzService via property authz: resolve() returns a promise there', source: src('src/guard.ts', 7) },
    ]);
  });

  it('reproduces S11: an un-awaited DI.resolve of an async service is a warning', () => {
    const m = fixture({
      services: [
        service({ className: 'AuthzService', async: true, registeredAs: ['AuthzService'] }),
        service({
          className: 'PrincipalMiddleware', async: true, registeredAs: ['ServerMiddleware', 'PrincipalMiddleware'],
          imperativeResolves: [{ token: 'AuthzService', method: 'rootService', awaited: false, source: src('src/principals/middleware.ts', 106, '@spinajs/authz-http') }],
        }),
      ],
    });
    expect(asyncIntoSync.run(m, ctx)).to.deep.equal([
      { code: 'DI003', severity: 'warning', message: 'PrincipalMiddleware.rootService calls DI.resolve(AuthzService) on an asynchronous service without await: the result is a cached instance or a promise', source: src('src/principals/middleware.ts', 106, '@spinajs/authz-http') },
    ]);
  });

  it('is silent for awaited resolves, sync providers and async consumers', () => {
    const m = fixture({
      services: [
        service({ className: 'AuthzService', async: true }),
        service({ className: 'Log', async: false }),
        service({ className: 'Ok', async: true, propertyInjects: [{ property: 'a', token: 'AuthzService', optional: false, array: false }], imperativeResolves: [{ token: 'AuthzService', method: 'x', awaited: true, source: src('src/ok.ts') }] }),
        service({ className: 'Ok2', async: false, propertyInjects: [{ property: 'l', token: 'Log', optional: false, array: false }] }),
      ],
    });
    expect(asyncIntoSync.run(m, ctx)).to.deep.equal([]);
  });

  it('is silent for a sync service whose async property dependency the container awaits', () => {
    const m = fixture({
      services: [
        service({ className: 'AuthzService', async: true, registeredAs: ['AuthzService'] }),
        service({ className: 'Middleware', async: false, propertyInjects: [{ property: 'authz', token: 'AuthzService', optional: false, array: false }], imperativeResolves: [{ token: 'AuthzService', method: 'x', awaited: true, source: src('src/m.ts') }] }),
      ],
    });
    expect(asyncIntoSync.run(m, ctx)).to.deep.equal([]);
  });

  it('exempts only Configuration: another async provider next to it is still reported', () => {
    const inject = (token: string) => ({ property: token, token, optional: false, array: false });
    const m = fixture({
      services: [
        service({ className: 'AppConfiguration', async: true, registeredAs: ['Configuration'] }),
        service({ className: 'Store', async: true, registeredAs: ['Store'] }),
        service({
          className: 'Reader', async: false, propertyInjects: [inject('Configuration'), inject('Store')],
          imperativeResolves: [{ token: 'Other', method: 'run', awaited: false, source: src('src/r.ts') }],
        }),
      ],
    });
    expect(asyncIntoSync.run(m, ctx).map((d) => d.message)).to.deep.equal(['Reader is synchronous but injects asynchronous Store via property Store: resolve() returns a promise there']);
  });
});
