/** An Orm whose `'default'` connection is a recording MySQL or MSSQL driver, so model queries compile for that dialect. */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI, IContainer } from '@spinajs/di';
import type { IColumnDescriptor, OrmDriver } from '@spinajs/orm';
import { Orm } from '@spinajs/orm';

import { FakeMsSql, FakeMySql } from './fake-drivers.js';
import type { Recording } from './fake-drivers.js';

type Col = [name: string, type: string, nullable?: boolean];

// The columns of the authn-orm migration; the Orm attaches converters only to columns tableInfo reports.
const TABLES: Record<string, { key: string[]; columns: Col[] }> = {
  authn_identity: {
    key: ['id'],
    columns: [['id', 'varchar'], ['identity_type', 'varchar'], ['identity_id', 'varchar'], ['provider', 'varchar'], ['subject', 'varchar'], ['email', 'varchar', true], ['email_verified', 'tinyint'], ['attributes', 'text', true], ['linked_at', 'datetime'], ['last_used_at', 'datetime', true]],
  },
  authn_throttle: { key: ['k'], columns: [['k', 'varchar'], ['attempts', 'int'], ['last_attempt_at', 'datetime'], ['next_allowed_at', 'datetime'], ['updated_at', 'datetime']] },
  authn_audit: {
    key: ['id'],
    columns: [['id', 'varchar'], ['at', 'datetime'], ['type', 'varchar'], ['outcome', 'varchar'], ['identity', 'varchar', true], ['actor', 'varchar', true], ['strategy', 'varchar', true], ['reason', 'varchar', true], ['ip', 'varchar', true], ['user_agent', 'varchar', true], ['session', 'varchar', true], ['data', 'text', true]],
  },
  authn_secret: { key: ['id'], columns: [['id', 'varchar'], ['identity', 'varchar'], ['purpose', 'varchar'], ['secret_hash', 'varchar'], ['expires_at', 'datetime'], ['used_at', 'datetime', true], ['created_at', 'datetime']] },
  authn_mfa: { key: ['identity', 'step'], columns: [['identity', 'varchar'], ['step', 'varchar'], ['secret_enc', 'text'], ['secret_hash', 'varchar'], ['key_id', 'varchar'], ['confirmed_at', 'datetime', true], ['last_step', 'bigint', true], ['created_at', 'datetime']] },
  authn_recovery_code: { key: ['id'], columns: [['id', 'varchar'], ['identity', 'varchar'], ['code_hash', 'varchar'], ['used_at', 'datetime', true]] },
  authn_nonce: { key: ['k'], columns: [['k', 'varchar'], ['expires_at', 'datetime']] },
};

function describeTable(table: string): IColumnDescriptor[] {
  const t = TABLES[table];
  if (!t) return null as unknown as IColumnDescriptor[];
  return t.columns.map(([name, type, nullable]) => ({
    Name: name,
    Type: type,
    NativeType: type,
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    Unsigned: false,
    Nullable: nullable === true,
    PrimaryKey: t.key.includes(name),
    AutoIncrement: false,
    Converter: undefined,
    Schema: {},
    Unique: false,
    Uuid: false,
    Ignore: false,
    Aggregate: false,
    Virtual: false,
    IsForeignKey: false,
    ForeignKeyDescription: undefined,
  }));
}

class DescribedMySql extends FakeMySql {
  public tableInfo(name?: string): Promise<IColumnDescriptor[]> {
    return Promise.resolve(describeTable(name ?? ""));
  }
}

class DescribedMsSql extends FakeMsSql {
  public tableInfo(name?: string): Promise<IColumnDescriptor[]> {
    return Promise.resolve(describeTable(name ?? ""));
  }
}

export const FAKE_DIALECTS = { mysql: DescribedMySql, mssql: DescribedMsSql } as const;

export interface FakeOrm {
  readonly driver: OrmDriver & Recording;
  readonly container: IContainer;
  dispose(): Promise<void>;
}

/** Boots an Orm on a recording driver; `executed` starts empty after the boot. */
export async function bootFakeOrm(dialect: keyof typeof FAKE_DIALECTS): Promise<FakeOrm> {
  DI.setESMModuleSupport();
  const driverName = `orm-driver-fake-${dialect}`;
  const connection = { Name: `n4-fake-${dialect}`, Driver: driverName, Migration: { OnStartup: false } };

  class FakeOrmConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      const config = this.Config as Record<string, unknown>;
      config.db = { ...(config.db as object), DefaultConnection: connection.Name, Connections: [connection] };
    }
  }

  const container = DI.child();
  container.register(FakeOrmConfiguration).as(Configuration);
  container.register(FAKE_DIALECTS[dialect]).as(driverName);
  await container.resolve(Configuration);
  const orm = await container.resolve(Orm);
  const driver = orm.Connections.get('default') as OrmDriver & Recording;
  driver.executed = [];

  return { driver, container, dispose: () => orm.dispose() };
}
