import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, Orm, QueryContext, RawQuery, SchemaQueryBuilder, SelectQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection() {
  return DI.get(Orm)!.Connections.get('sqlite')!;
}

function schqb() {
  return connection().Container.resolve(SchemaQueryBuilder, [connection()]);
}

describe('create view, shared compiler', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('returns a schema builder', () => {
    const builder = schqb().createView('v', (view) => view.as(new RawQuery('SELECT 1')));

    expect(builder).to.be.instanceOf(CreateViewQueryBuilder);
    expect(builder.QueryContext).to.eq(QueryContext.Schema);
  });

  it('compiles the portable core', () => {
    const result = schqb()
      .createView('active_users', (view) => view.as(new RawQuery('SELECT * FROM users')))
      .toDB();

    expect(result.expression).to.eq('CREATE VIEW `active_users` AS SELECT * FROM users');
    expect(result.bindings).to.deep.eq([]);
  });

  it('qualifies the name with the database', () => {
    const result = schqb()
      .createView('active_users', (view) => view.database('app').as(new RawQuery('SELECT 1')))
      .toDB();

    expect(result.expression).to.eq('CREATE VIEW `app`.`active_users` AS SELECT 1');
  });

  it('writes an explicit column list', () => {
    const result = schqb()
      .createView('v', (view) => view.columns(['id', 'name']).as(new RawQuery('SELECT 1, 2')))
      .toDB();

    expect(result.expression).to.eq('CREATE VIEW `v` (`id`,`name`) AS SELECT 1, 2');
  });

  it('builds the body from a select callback and inlines its bindings', () => {
    const result = schqb()
      .createView('v', (view) => view.as((select) => select.from('users').where('isDeleted', 0).where('role', `adm'in`)))
      .toDB();

    expect(result.expression).to.eq("CREATE VIEW `v` AS SELECT * FROM `users` WHERE `isDeleted` = 0 AND `role` = 'adm''in'");
    expect(result.bindings).to.deep.eq([]);
  });

  it('takes a ready select builder', () => {
    const select = new SelectQueryBuilder(connection().Container, connection());
    select.from('users').where('age', '>', 18);

    const result = schqb().createView('v', (view) => view.as(select)).toDB();

    expect(result.expression).to.eq('CREATE VIEW `v` AS SELECT * FROM `users` WHERE `age` > 18');
  });

  it('inlines the bindings of a raw body', () => {
    const result = schqb()
      .createView('v', (view) => view.as(new RawQuery('SELECT * FROM users WHERE age > ? AND role = ?', [18, 'admin'])))
      .toDB();

    expect(result.expression).to.eq("CREATE VIEW `v` AS SELECT * FROM users WHERE age > 18 AND role = 'admin'");
  });

  it('refuses a view without a body', () => {
    expect(() => schqb().createView('v', () => undefined).toDB()).to.throw(InvalidOperation, /no body/);
  });

  const optional: [string, (view: CreateViewQueryBuilder) => unknown][] = [
    ['OR REPLACE', (view) => view.orReplace()],
    ['IF NOT EXISTS', (view) => view.ifNotExists()],
    ['TEMPORARY', (view) => view.temporary()],
    ['ALGORITHM', (view) => view.algorithm('MERGE')],
    ['SQL SECURITY', (view) => view.security('INVOKER')],
    ['CHECK OPTION', (view) => view.checkOption()],
  ];

  for (const [clause, apply] of optional) {
    it(`throws for ${clause}, which only a driver can enable`, () => {
      const builder = schqb().createView('v', (view) => {
        apply(view);
        view.as(new RawQuery('SELECT 1'));
      });

      expect(() => builder.toDB()).to.throw(MethodNotImplemented, clause);
    });
  }

  it('refuses option values outside their allow-list', () => {
    expect(() => schqb().createView('v', (view) => view.algorithm('MERGE; DROP TABLE x' as any))).to.throw(InvalidArgument);
    expect(() => schqb().createView('v', (view) => view.security('ROOT' as any))).to.throw(InvalidArgument);
    expect(() => schqb().createView('v', (view) => view.checkOption('GLOBAL' as any))).to.throw(InvalidArgument);
  });
});
