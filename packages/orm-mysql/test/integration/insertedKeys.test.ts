/**
 * The keys MySQL reports for inserted rows, against a live server: `ModelBase.insert`, a multi-row static insert and the
 * write capture, the step of the walk, and what INSERT IGNORE, ON DUPLICATE KEY UPDATE and REPLACE report.
 *
 *   npx ts-mocha -p tsconfig.json test/integration/insertedKeys.test.ts
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, InsertBehaviour, Model, ModelBase, Orm, Primary, QueryContext, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, OrmDriver, WriteStatement } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `orm_keys_${randomUUID().slice(0, 8)}`;

@Connection('keys')
@Model('ik_item')
class Item extends ModelBase<Item> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

@Connection('keys-untracked')
@Model('ik_item')
class UntrackedItem extends ModelBase<UntrackedItem> {
  @Primary()
  public Id: number;

  public Email: string;

  public Name: string;
}

const writes: CapturedWrite[] = [];

class Recorder extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === Item ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
  }
}

class KeysConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
    this.Config.db = {
      ...(this.Config.db as object),
      Migration: { Startup: false },
      StrictTableCheck: false,
      DefaultConnection: 'keys',
      Connections: [
        { Driver: 'orm-driver-mysql', Name: 'keys', ...SERVER, Database: DATABASE },
        // without the SESSION_TRACK capability the server reports no step, so the connection never learns it
        { Driver: 'orm-driver-mysql', Name: 'keys-untracked', ...SERVER, Database: DATABASE, Options: { flags: ['-SESSION_TRACK'] } },
      ],
    };
  }
}

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: SERVER.Host, port: SERVER.Port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const driver = (name = 'keys'): OrmDriver => DI.get(Orm)!.Connections.get(name)!;
const sql = async (statement: string): Promise<void> => {
  await driver().schema().raw(statement);
};
const idsOf = async (emails: string[]): Promise<number[]> => {
  const found = await driver().select<Array<{ Id: number; Email: string }>>().from('ik_item').whereIn('Email', emails);
  return emails.map((e) => found.find((r) => r.Email === e)!.Id);
};
const items = (...emails: string[]) => emails.map((Email) => new Item({ Email, Name: Email }));

describe('inserted keys on mysql (integration)', function () {
  this.timeout(60000);

  let admin: MySqlOrmDriver | undefined;

  before(async function () {
    if (!(await reachable())) {
      console.warn(`      MySQL at ${SERVER.Host}:${SERVER.Port} is unreachable, suite skipped`);
      this.skip();
    }

    admin = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'keys-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await admin.connect();
    await admin.schema().createDatabase(DATABASE);

    DI.clearCache();
    DI.register(KeysConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    DI.register(Recorder).as(WriteObserver);
    await DI.resolve(Orm);
    await sql('CREATE TABLE ik_item (Id INT AUTO_INCREMENT PRIMARY KEY, Email VARCHAR(64) NOT NULL UNIQUE, Name VARCHAR(64))');
    await DI.get(Orm)!.reloadTableInfo();
  });

  beforeEach(async () => {
    await sql('TRUNCATE TABLE ik_item');
    await sql("INSERT INTO ik_item (Email, Name) VALUES ('seed-1', 'one'), ('seed-2', 'two')");
    writes.length = 0;
  });

  after(async () => {
    if (!admin) return;
    for (const name of ['keys', 'keys-untracked']) await DI.get(Orm)?.Connections.get(name)?.disconnect();
    DI.unregister(Recorder);
    DI.clearCache();
    await admin.executeOnDb(`DROP DATABASE IF EXISTS \`${DATABASE}\``, [], QueryContext.Schema);
    await admin.disconnect();
  });

  it('gives ModelBase.insert the key of its row', async () => {
    const [item] = items('a');
    await item.insert();

    expect(item.Id).to.eq((await idsOf(['a']))[0]);
  });

  it('gives every row of a multi-row static insert its key', async () => {
    const batch = items('a', 'b', 'c');
    await Item.insert(batch);

    expect(batch.map((i) => i.Id)).to.deep.eq(await idsOf(['a', 'b', 'c']));
  });

  it("walks the block by the session's auto_increment_increment", async () => {
    const batch = items('a', 'b', 'c');
    await driver().transaction(async () => {
      await sql('SET SESSION auto_increment_increment = 3');
      try {
        await Item.insert(batch);
      } finally {
        await sql('SET SESSION auto_increment_increment = 1');
      }
    });

    const ids = await idsOf(['a', 'b', 'c']);
    expect(ids[1] - ids[0]).to.eq(3);
    expect(batch.map((i) => i.Id)).to.deep.eq(ids);
  });

  it('keys no row of a multi-row insert on a connection whose step is unknown, and still keys a single row', async () => {
    const batch = ['a', 'b'].map((Email) => new UntrackedItem({ Email, Name: Email }));
    await UntrackedItem.insert(batch);
    const single = new UntrackedItem({ Email: 'c', Name: 'c' });
    await single.insert();

    expect(batch.map((i) => i.Id)).to.deep.eq([null, null]);
    expect(single.Id).to.eq((await idsOf(['c']))[0]);
  });

  it('reports the keys of a multi-row insert to the write capture', async () => {
    await Item.insert(items('a', 'b'));

    const ids = await idsOf(['a', 'b']);
    expect(writes[0].unknownKeys).to.eq(false);
    expect(writes[0].rows.map((r) => r.id)).to.deep.eq(ids.map(String));
    expect(writes[0].rows.map((r) => r.after?.['Email'])).to.deep.eq(['a', 'b']);
  });

  it('keys an INSERT IGNORE that inserted its row, and not one that skipped it', async () => {
    const [fresh] = items('a');
    await fresh.insert(InsertBehaviour.InsertOrIgnore);
    const [skipped] = items('seed-1');
    await skipped.insert(InsertBehaviour.InsertOrIgnore);

    expect(fresh.Id).to.eq((await idsOf(['a']))[0]);
    expect(skipped.Id).to.eq(null);
  });

  it('keys the row ON DUPLICATE KEY UPDATE inserted or updated, and not one it left unchanged', async () => {
    const [fresh] = items('a');
    await fresh.insert(InsertBehaviour.InsertOrUpdate);
    const updated = new Item({ Email: 'seed-1', Name: 'changed' });
    await updated.insert(InsertBehaviour.InsertOrUpdate);
    const unchanged = new Item({ Email: 'seed-2', Name: 'two' });
    await unchanged.insert(InsertBehaviour.InsertOrUpdate);

    expect([fresh.Id, updated.Id, unchanged.Id]).to.deep.eq([...(await idsOf(['a', 'seed-1'])), null]);
  });

  it('keys the new row of a REPLACE, also when it deleted the row it conflicted with', async () => {
    const [fresh] = items('a');
    await fresh.insert(InsertBehaviour.InsertOrReplace);
    const [before] = await idsOf(['seed-1']);
    const [replacing] = items('seed-1');
    await replacing.insert(InsertBehaviour.InsertOrReplace);

    const ids = await idsOf(['a', 'seed-1']);
    expect([fresh.Id, replacing.Id]).to.deep.eq(ids);
    expect(replacing.Id).to.not.eq(before);
  });
});
