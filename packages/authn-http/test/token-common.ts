import { DI } from '@spinajs/di';
import { Controllers } from '@spinajs/http';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';
import cookieParser from 'cookie-parser';

import { registerRootSchemas } from './support/root-schemas.js';
import { dropOwnCompiledDirs } from './token-db-common.js';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export const COOKIE_SECRET = 'authn-http-token-test-secret';

/** The app's origin as a browser on it sends it; cookie requests with an unsafe method need it (A22). */
export const APP_ORIGIN = 'http://localhost:8889';

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
    registerRootSchemas();
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
          // The controller listing is memoized once per process ( `ListFromFiles`
          // in reflection ), so every http suite in this package has to ask for the
          // same directories. No 2.x controller dir: the shipped config scans none.
          controllers: [dir('./../src/v3/controllers'), dir('./support')],
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
      authn: {
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
          cookie: { secure: false },
        },
        local: {
          policy: { rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' } },
          reset: { ttlSeconds: 60 * 60 },
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
