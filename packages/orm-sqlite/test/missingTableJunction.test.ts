import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { SqliteOrmDriver } from '../src/index.js';
import { db } from './common.js';
import { bootUow, registerUowConnection, UowOrder, UowTag } from './uowFixture.js';

const sqlite = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const run = (stmt: string) => sqlite().executeOnDb(stmt, [], QueryContext.Schema);
const rows = (stmt: string) => sqlite().executeOnDb(stmt, [], QueryContext.Select);

const REFUSAL = /^model UowOrderTag: table uow_order_tag on connection sqlite was missing when the Orm read it/;

async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('sqlite: junction data of a junction model whose table was missing when the Orm read it', function () {
  this.timeout(60000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    await run('DROP TABLE uow_order_tag');
    await db().reloadTableInfo();
    await run('CREATE TABLE uow_order_tag (Id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, tag_id INTEGER, Note TEXT)');
  });

  afterEach(() => DI.clearCache());

  it('refuses save() of a link with junction data instead of writing its keys only', async () => {
    const order = new UowOrder({ Total: 1 });
    order.Tags.add(new UowTag({ Name: 't' }), { Note: 'n' });

    const err = await rejection(order.save());

    expect((err as Error)?.message).to.match(REFUSAL);
    expect(await rows('SELECT * FROM uow_order_tag')).to.deep.equal([]);
  });

  it('refuses Tags.update() of a link with a clear message', async () => {
    const order = new UowOrder({ Total: 1 });
    await order.save();
    order.Tags.add(new UowTag({ Name: 't' }));

    const err = await rejection(order.Tags.update());

    expect((err as Error)?.message).to.match(REFUSAL);
    expect(await rows('SELECT * FROM uow_order_tag')).to.deep.equal([]);
  });

  it('writes the junction data after reloadTableInfo()', async () => {
    await db().reloadTableInfo();
    const order = new UowOrder({ Total: 1 });
    order.Tags.add(new UowTag({ Name: 't' }), { Note: 'n' });

    await order.save();

    expect(await rows('SELECT Note FROM uow_order_tag')).to.deep.equal([{ Note: 'n' }]);
  });
});
