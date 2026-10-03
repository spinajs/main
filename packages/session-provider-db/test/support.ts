import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { AbsoluteExpiration, DefaultSessionIssuer, SessionExpirationProvider, SessionProvider, SlidingCappedExpiration, SlidingExpiration, encodeSessionData } from '@spinajs/authn-session';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { DbSessionStore } from '../src/index.js';
import { DbSession } from '../src/models/DbSession.js';

let sessionOverrides: Record<string, unknown> = {};

export class DbSessionTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.merge(this.Config, {
      authn: {
        session: {
          service: 'DbSessionStore',
          expiration: { service: 'SlidingExpiration', ttl: 60 },
          db: { cleanupInterval: 1000 },
        },
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'session-provider-connection', Migration: { OnStartup: true } },
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { OnStartup: true } },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    });
    _.merge(this.Config, { authn: { session: sessionOverrides } });
  }
}

/** Types these tests resolve; uncached between boots instead of a blanket DI.clearCache(). */
const OWNED_TYPES: unknown[] = [Configuration, DbSessionTestConfiguration, Orm, SessionProvider, DbSessionStore, SessionExpirationProvider, AbsoluteExpiration, SlidingExpiration, SlidingCappedExpiration, DefaultSessionIssuer, SessionIssuer];

let registered = false;
let current: { orm: Orm; store: DbSessionStore } | undefined;

async function shutdown(): Promise<void> {
  if (current) {
    await current.store.dispose();
    await current.orm.dispose();
    current = undefined;
  }
  for (const t of OWNED_TYPES) {
    DI.uncache(t as never);
  }
}

/** A fresh in-memory database with every migration applied, and the store over it. */
export async function bootStore(session: Record<string, unknown> = {}): Promise<DbSessionStore> {
  await shutdown();
  if (!registered) {
    // The configuration loader reads every @spinajs package's config; without this it tries their CommonJS builds.
    DI.setESMModuleSupport();
    DI.register(DbSessionTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    registered = true;
  }

  sessionOverrides = session;
  await DI.resolve(Configuration);
  const orm = await DI.resolve(Orm);
  const store = await DI.resolve(DbSessionStore);
  current = { orm, store };
  return store;
}

export const disposeStore = shutdown;

export async function sessionConnection(): Promise<OrmDriver> {
  return (await DI.resolve(Orm)).Connections.get('session-provider-connection')!;
}

/** A row as the 2.x store wrote it: raw uuid key, numeric UserId, identity only in Data, no 3.0 columns. */
export interface LegacyRow {
  rawId: string;
  user?: string;
  authorized: boolean;
  impersonator?: string;
  creation: DateTime;
  expiration?: DateTime;
}

export async function seedLegacyRow(row: LegacyRow): Promise<void> {
  const data = new Map<string, unknown>([['Logged', true]]);
  if (row.user !== undefined) data.set('User', row.user);
  data.set('Authorized', row.authorized);
  if (row.impersonator) data.set('Impersonator', row.impersonator);

  await (
    await sessionConnection()
  )
    .insert()
    .into('user_sessions')
    .values({
      SessionId: row.rawId,
      CreatedAt: row.creation,
      Expiration: row.expiration ?? null,
      Data: encodeSessionData(data),
      UserId: 1,
    });
}

export async function storedKeys(): Promise<string[]> {
  return (await DbSession.all()).map((r) => r.SessionId);
}
