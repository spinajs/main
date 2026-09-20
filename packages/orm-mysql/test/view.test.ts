import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, LiteralQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';
import { MySqlLiteralQuoter } from '../src/statements.js';

describe('mysql views', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-view-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);
  const view = (build: (view: CreateViewQueryBuilder) => void) => schema().createView('campaign_view', build);

  it('registers its own view compiler and literal quoter', () => {
    expect(driver.Container.hasRegistered('CreateViewCompiler')).to.eq(true);
    expect(driver.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(MySqlLiteralQuoter);
  });

  it('compiles every clause mysql has, in mysql order', () => {
    const result = view((v) => v.database('arrow4').orReplace().algorithm('UNDEFINED').security('DEFINER').columns(['id', 'name']).checkOption('CASCADED').as(new RawQuery('SELECT id, name FROM arrow_campaign'))).toDB();

    expect(result.expression).to.eq('CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `arrow4`.`campaign_view` (`id`,`name`) AS SELECT id, name FROM arrow_campaign WITH CASCADED CHECK OPTION');
    expect(result.bindings).to.deep.eq([]);
  });

  it('compiles the plain and the local check option', () => {
    expect(view((v) => v.checkOption().as(new RawQuery('SELECT 1'))).toDB().expression).to.eq('CREATE VIEW `campaign_view` AS SELECT 1 WITH CHECK OPTION');
    expect(view((v) => v.checkOption('LOCAL').as(new RawQuery('SELECT 1'))).toDB().expression).to.eq('CREATE VIEW `campaign_view` AS SELECT 1 WITH LOCAL CHECK OPTION');
  });

  it('throws for the clauses mysql does not have', () => {
    expect(() => view((v) => v.ifNotExists().as(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'mysql does not support IF NOT EXISTS');
    expect(() => view((v) => v.temporary().as(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'mysql does not support TEMPORARY');
  });

  it('inlines select bindings with mysql escaping', () => {
    const result = view((v) => v.as((select) => select.from('users').where('isDeleted', 0).where('name', `it's`))).toDB();

    expect(result.expression).to.eq("CREATE VIEW `campaign_view` AS SELECT * FROM `users` WHERE `isDeleted` = 0 AND `name` = 'it\\'s'");
  });

  it('escapes backslashes, which mysql reads as escapes inside a literal', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote('a\\b')).to.eq("'a\\\\b'");
    expect(quoter.quote(`'; DROP TABLE x; --`)).to.eq("'\\'; DROP TABLE x; --'");
    expect(quoter.quote(true)).to.eq('1');
  });

  it('drops a view', () => {
    expect(schema().dropView('campaign_view', 'arrow4').ifExists().toDB().expression).to.eq('DROP VIEW IF EXISTS `arrow4`.`campaign_view`');
  });
});
