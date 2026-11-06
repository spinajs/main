import 'mocha';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { Orm, QueryContext } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver, SHARED_IDLE_CLOSE_MS, acquireSharedPglite, execOnSharedPglite } from '../src/index.js';

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
const INSTANCE = 'orm-pglite-shared-test';

const configuration: Class<Configuration> = class SharedConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('logger', SILENT);
    this.set('db', {
      StrictTableCheck: false,
      Connections: [
        { Driver: 'orm-driver-pglite', Name: 'a', Options: { Shared: INSTANCE, Schema: 'shared_a' } },
        { Driver: 'orm-driver-pglite', Name: 'b', Options: { Shared: INSTANCE, Schema: 'shared_b' } },
      ],
    });
  }
};

const rows = (driver: PgliteOrmDriver, sql: string) => driver.executeOnDb(sql, [], QueryContext.Select) as Promise<unknown[]>;

describe('shared PGlite instance', function () {
  let app: TestApp;
  let a: PgliteOrmDriver;
  let b: PgliteOrmDriver;

  before(async () => {
    app = await createTestApp({ configuration, register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    const orm = await app.resolve(Orm);
    a = orm.Connections.get('a') as PgliteOrmDriver;
    b = orm.Connections.get('b') as PgliteOrmDriver;
    for (const driver of [a, b]) {
      await driver.schema().createTable('sh_items', (t) => {
        t.int('Id').primaryKey();
      });
    }
  });

  after(async () => {
    await app.dispose();
  });

  it('gives each connection its own schema on one instance', async () => {
    await a.executeOnDb('INSERT INTO sh_items ("Id") VALUES (?)', [1], QueryContext.Insert);

    expect(await rows(a, 'SELECT current_schema() AS s')).to.deep.equal([{ s: 'shared_a' }]);
    expect(await rows(b, 'SELECT current_schema() AS s')).to.deep.equal([{ s: 'shared_b' }]);
    expect(await rows(a, 'SELECT "Id" FROM sh_items')).to.deep.equal([{ Id: 1 }]);
    expect(await rows(b, 'SELECT "Id" FROM sh_items')).to.deep.equal([]);
  });

  it('runs another connection only after a transaction ends, in its own schema', async () => {
    const order: string[] = [];
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const tx = a.transaction(async () => {
      await a.executeOnDb('INSERT INTO sh_items ("Id") VALUES (?)', [2], QueryContext.Insert);
      order.push('a:inserted');
      await gate;
      order.push('a:commit');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = rows(b, 'SELECT current_schema() AS s').then((r) => {
      order.push('b:read');
      return r;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    await tx;

    expect(await other).to.deep.equal([{ s: 'shared_b' }]);
    expect(order).to.deep.equal(['a:inserted', 'a:commit', 'b:read']);
  });

  it('runs a statement on the open instance and nothing on a closed one', async () => {
    expect(await execOnSharedPglite(INSTANCE, 'DROP SCHEMA shared_b CASCADE')).to.equal(true);
    expect(await rows(a, `SELECT nspname FROM pg_namespace WHERE nspname = 'shared_b'`)).to.deep.equal([]);
    expect(await execOnSharedPglite('never-opened', 'SELECT 1')).to.equal(false);
  });

  it('keeps an instance while it is held and closes it once released for a moment', async () => {
    const first = await acquireSharedPglite('orm-pglite-idle-test', 5000);
    const second = await acquireSharedPglite('orm-pglite-idle-test', 5000);
    expect(second.pool).to.equal(first.pool);

    first.release();
    second.release();
    await new Promise((resolve) => setTimeout(resolve, SHARED_IDLE_CLOSE_MS + 200));

    const third = await acquireSharedPglite('orm-pglite-idle-test', 5000);
    expect(third.pool).to.not.equal(first.pool);
    third.release();
  });
});
