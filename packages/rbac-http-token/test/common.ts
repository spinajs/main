import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import { SessionProvider, UserSession, User } from '@spinajs/rbac';
import * as cs from 'cookie-signature';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';
import cookieParser from 'cookie-parser';

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
 * Boots in-memory sqlite plus a real http server on 8889 with this package's
 * controllers. Mirrors `db-common.ts` and adds the http/server wiring.
 */
export class TestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          controllers: [dir('./../src/controllers')],
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
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
          },
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
