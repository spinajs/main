import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import _ from 'lodash';
import * as sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InsertQueryBuilder, Orm } from '@spinajs/orm';
import { SqlInsertQueryCompiler } from '../src/compilers.js';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { UuidModel } from './Models/UuidModel.js';

class QualifiedConnectionConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 'acct');
  }
}

function iqb() {
  const connection = DI.get(Orm)!.Connections.get('sqlite')!;
  return connection.Container.resolve(InsertQueryBuilder, [connection]);
}

describe('insert into a schema', () => {
  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('builder', () => {
    beforeEach(async () => {
      DI.register(ConnectionConf).as(Configuration);
      DI.register(FakeSqliteDriver).as('sqlite');
      await DI.resolve(Orm);
    });

    it('qualifies the table with the schema given to into()', () => {
      const result = iqb().into('users', 'archive').values({ id: 1 }).toDB();

      expect(result.expression).to.equal('INSERT INTO `archive`.`users` (`id`) VALUES (?)');
    });

    it('gives the table no alias', () => {
      const query = iqb().into('users', 'archive');

      expect(query.Database).to.equal('archive');
      expect(query.TableAlias).to.equal(undefined);
    });

    it('leaves into() with one argument unqualified', () => {
      const result = iqb().into('users').values({ id: 1 }).toDB();

      expect(result.expression).to.equal('INSERT INTO `users` (`id`) VALUES (?)');
    });
  });

  describe('model', () => {
    beforeEach(async () => {
      DI.register(QualifiedConnectionConf).as(Configuration);
      DI.register(FakeSqliteDriver).as('sqlite');
      await DI.resolve(Orm);
    });

    it('qualifies a model insert with the connection database', async () => {
      const compile = sinon.spy(SqlInsertQueryCompiler.prototype, 'compile');

      await UuidModel.insert(new UuidModel());

      expect(compile.returnValues[0].expression).to.equal('INSERT INTO `acct`.`TestTable2` (`Id`) VALUES (?)');
    });
  });
});
