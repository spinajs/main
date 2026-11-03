import { migrateTestDatabase } from '@spinajs/orm/testing';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { SqliteOrmDriver } from '../../lib/mjs/index.js';

class Conf extends FrameworkConfiguration {
  async resolve() {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'subpath-only' }] },
    });
  }
}

DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
DI.register(Conf).as(Configuration);

const { orm, executed } = await migrateTestDatabase();
console.log(JSON.stringify({ executed: executed.length }));
await orm.dispose();
process.exit(0);
