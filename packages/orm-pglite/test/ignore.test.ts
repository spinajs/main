import 'mocha';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { Connection, Ignore, Model, ModelBase, Orm, Primary } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const CONNECTION = 'pglite-ignore';
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

@Connection(CONNECTION)
@Model('pgl_ignore')
class PglIgnore extends ModelBase<PglIgnore> {
  @Primary()
  public Id: number;

  public Name: string;

  @Ignore()
  public Scratch: string;
}

class IgnoreConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('logger', SILENT);
    this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION }] });
  }
}

describe('PGlite @Ignore() property', function () {
  it('creates, updates and inserts many rows of a model whose ignored property has no column', async () => {
    const app = await createTestApp({ configuration: IgnoreConfiguration as Class<Configuration>, register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    try {
      const orm = await app.resolve(Orm);
      await orm.Connections.get(CONNECTION)!.schema().createTable('pgl_ignore', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Name');
      });
      await orm.reloadTableInfo();

      const row = await PglIgnore.create({ Name: 'a', Scratch: 'temp' });
      expect(row.Scratch).to.equal('temp');

      row.Scratch = 'only';
      expect(await row.update()).to.deep.equal({ RowsAffected: 0, LastInsertId: 0 });

      row.Name = 'b';
      await row.update();

      await PglIgnore.insert([new PglIgnore({ Name: 'c', Scratch: 'x' }), { Name: 'd', Scratch: 'y' }]);

      expect((await PglIgnore.all()).map((r) => r.Name).sort()).to.deep.equal(['b', 'c', 'd']);
      expect(new PglIgnore({ Name: 'e', Scratch: 'z' }).toSql()).to.not.have.property('Scratch');
    } finally {
      await app.dispose();
    }
  });
});
