import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import { SessionProvider, UserSession, User } from '@spinajs/rbac';
import * as cs from 'cookie-signature';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';
import cookieParser from 'cookie-parser';

import { dropOwnCompiledDirs } from './db-common.js';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export const COOKIE_SECRET = 'rbac-http-token-test-secret';

export function req() {
  return chai.request('http://localhost:8889/');
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * The exception -> http response map, captured before any suite can wipe it.
 *
 * `@HandleException` builds it ONCE, while `@spinajs/http` is being imported,
 * and stores it straight in the container CACHE with no registry entry to
 * rebuild it from ( `DI.register(target).asMapValue('__http_error_map__', ...)`,
 * `http/src/decorators.ts:281` ). Every suite in this package ends with
 * `DI.clearCache()`, which throws the map away - and `__handle_error__`
 * ( `http/src/error.ts:51` ) then finds no mapping for `AuthenticationFailed` or
 * `Forbidden` and answers 500 where the policy asked for 401 / 403.
 *
 * Reading it here is safe because mocha loads every spec file - and with them
 * this module, which imports `@spinajs/http` above - before it runs the first
 * hook of the first suite.
 */
const HTTP_ERROR_MAP = DI.get('__http_error_map__');

/**
 * Puts the captured error map back, so a suite's status assertions do not
 * depend on which suite ran ( and cleared the cache ) before it. Call from
 * `before()` of every suite that drives a real http server.
 */
export function restoreHttpErrorMap() {
  if (HTTP_ERROR_MAP) {
    // `ContainerCache.add` is keyed and de-duplicates by identity, so putting
    // the very same map back twice is a no-op.
    DI.RootContainer.Cache.add('__http_error_map__', HTTP_ERROR_MAP);
  }
}

/**
 * Boots in-memory sqlite plus a real http server on 8889 with this package's
 * controllers. Mirrors `db-common.ts` and adds the http/server wiring.
 */
export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    // see `dropOwnCompiledDirs` - without it this package's shipped config adds
    // its `lib/...` controllers and models next to the `src/...` ones below.
    dropOwnCompiledDirs(this);
  }

  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          // `./support` holds test only controllers ( see
          // `support/TestTokenController.ts` ) used by the end to end policy
          // suite; they are loaded exactly like the package's own ones.
          controllers: [dir('./../src/controllers'), dir('./support')],
          migrations: [dir('./../src/migrations')],
          models: [dir('./../src/models')],
        },
      },
      // `@spinajs/http` contributes the providers its own machinery needs
      // ( response templates, `__fs_controller_cache__` ); only the default has
      // to be named here, and `fsService` must be resolved before Controllers.
      fs: {
        defaultProvider: 'fs-temp',
        providers: [{ service: 'fsNative', name: 'fs-temp', basePath: dir('./files') }],
      },
      http: {
        port: 8889,
        cookie: { secret: COOKIE_SECRET },
        middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true }), cookieParser()],
        AcceptHeaders: 1,
      },
      rbac: {
        defaultRole: 'guest',
        // A guest that is not active cannot satisfy any grant, so an anonymous
        // request is rejected by the route policy rather than served.
        enableGuestAccount: false,
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
        ],
        grants: {
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'test.resource': { 'read:any': ['*'] },
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
            'test.resource': { 'read:own': ['*'] },
          },
          // `guest` is deliberately left WITHOUT any grant on `test.resource` -
          // the end to end suite uses a guest scoped token to prove that a valid
          // token still gets a 403 when its roles do not carry the grant.
        },
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
          cookie: { secure: false },
        },
        auth: { service: 'SimpleDbAuthProvider' },
        password: {
          service: 'BasicPasswordProvider',
          validation: { service: 'BasicPasswordValidationProvider', rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' } },
          passwordExpirationTime: 0,
          passwordResetWaitTime: 60 * 60,
        },
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'spt_',
          length: 32,
          headerName: 'x-api-key',
          lastUsedUpdateInterval: 60,
        },
      },
      queue: {
        default: 'default-test-queue',
        connections: [{ service: 'BlackHoleQueueClient', name: 'default-test-queue' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
    };
  }
}

/**
 * Creates an authorized session for the user and returns the signed `ssid`
 * cookie value ready for a `Cookie` header.
 *
 * `Authorized` is what `RbacPolicy` looks at, `User` carries the uuid the
 * `RbacUserFactory` reloads the row by - the same shape the login controller
 * writes.
 *
 * `MemorySessionStore` is registered with `@Injectable(SessionProvider)`
 * ( `rbac/src/session.ts` ), and `RbacMiddleware` injects the same abstract
 * base, so both sides land on one instance.
 *
 * @param user - the user the session acts AS ( the impersonation target, when
 *               `impersonator` is given )
 * @param impersonator - administrator who started an impersonation of `user`.
 *                       Stored under the `Impersonator` session key, which is
 *                       what `RbacMiddleware` reads to populate
 *                       `req.storage.Impersonator`. Must be an existing active
 *                       user - the middleware resolves it through
 *                       `RbacUserFactory`, which loads the row by uuid.
 */
export async function sessionCookieFor(user: User, impersonator?: User): Promise<string> {
  const provider = await DI.resolve(SessionProvider);
  const session = new UserSession();
  session.UserId = user.Id;
  session.Data.set('User', user.Uuid);
  session.Data.set('Authorized', true);
  session.Data.set('ActiveRole', user.Role[0]);

  if (impersonator) {
    session.Data.set('Impersonator', impersonator.Uuid);
  }

  await provider.save(session);

  return `ssid=${encodeURIComponent(cs.sign(session.SessionId, COOKIE_SECRET))}`;
}

export function ctr() {
  return DI.get(Controllers);
}

/**
 * Registers `TestConfiguration` as THE configuration, whatever ran before.
 *
 * `ContainerRegistry.register` de-duplicates by type name
 * ( `di/src/registry.ts:39` ), so a plain
 * `DI.register(TestConfiguration).as(Configuration)` is a NO-OP once this class
 * is already in the list - and `resolve` takes the LAST entry. A db-only suite
 * registering `DbTestConfiguration` after an http suite therefore stays the
 * winner: the http suite then boots with no `http.port` at all and binds the
 * framework default 1337 while every request in it goes to 8889.
 *
 * That failure mode is invisible in the default file order and appears the
 * moment mocha is given a file to run first, so the unregister is not
 * defensive - it is what makes these suites order independent.
 */
export function useTestConfiguration() {
  DI.unregister(TestConfiguration);
  DI.register(TestConfiguration).as(Configuration);
}
