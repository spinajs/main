import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

const DEFAULT_CONNECTION = 'sqlite';

let overrides: Record<string, unknown> = {};
let bootstrapped = false;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (isPlain(v) && isPlain(target[k])) merge(target[k] as Record<string, unknown>, v);
    else target[k] = v;
  }
}

class BenchAuthnConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    merge(this.Config as Record<string, unknown>, {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'info', target: 'Empty' }],
      },
      db: {
        DefaultConnection: DEFAULT_CONNECTION,
        Connections: [
          // The session table lives on its own connection name in the db session store.
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'session-provider-connection', Migration: { OnStartup: true } },
          { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: DEFAULT_CONNECTION, Migration: { OnStartup: true } },
        ],
      },
    });
    merge(this.Config as Record<string, unknown>, structuredClone(overrides));
  }
}

/** Everything the authn scenarios register in the global DI, to uncache between scenarios. */
const OWNED: unknown[] = [Configuration, BenchAuthnConfiguration, Orm, SqliteOrmDriver, 'orm-driver-sqlite'];

export interface AuthnBoot {
  /** Resolves a class in the booted container. */
  resolve<T>(type: abstract new (...args: never[]) => T): Promise<T>;
  /** Types the caller resolved and wants uncached on dispose. */
  own(...types: unknown[]): void;
  connection(name?: string): OrmDriver;
  dispose(): Promise<void>;
}

/**
 * Boots the global DI over a fresh in-memory sqlite database (every registered migration applied) with `authn.*` set
 * from `authn`. The bench runner shares one process between scenarios, so `dispose` must leave the DI as it was found.
 */
export async function bootAuthn(authn: Record<string, unknown>): Promise<AuthnBoot> {
  DI.setESMModuleSupport();
  const owned = [...OWNED];
  owned.forEach((t) => DI.uncache(t as never));

  if (!bootstrapped) {
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    bootstrapped = true;
  }

  overrides = { authn };
  DI.register(BenchAuthnConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  await DI.resolve(Configuration);
  const orm = await DI.resolve(Orm);

  return {
    resolve: (type) => DI.resolve(type as never) as never,
    own: (...types) => void owned.push(...types),
    connection: (name = DEFAULT_CONNECTION) => {
      const driver = orm.Connections.get(name);
      if (!driver) throw new Error(`no connection ${name}`);
      return driver;
    },
    dispose: async () => {
      await orm.dispose();
      owned.forEach((t) => DI.uncache(t as never));
      DI.unregister(BenchAuthnConfiguration);
      DI.unregister(SqliteOrmDriver);
    },
  };
}
