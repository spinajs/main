import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, LiteralQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { PostgresOrmDriver, toDriverStatement } from '../src/index.js';
import { PostgresLiteralQuoter } from '../src/statements.js';

describe('postgres views', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'postgres-view-test', Driver: 'orm-driver-postgres' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);
  const view = (build: (view: CreateViewQueryBuilder) => void) => schema().createView('active_users', build);

  it('registers its own view compiler and literal quoter', () => {
    expect(driver.Container.hasRegistered('CreateViewCompiler')).to.eq(true);
    expect(driver.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(PostgresLiteralQuoter);
  });

  it('compiles every clause postgres has, in postgres order', () => {
    const result = view((v) => v.orReplace().temporary().columns(['id', 'name']).security('INVOKER').checkOption('LOCAL').as(new RawQuery('SELECT id, name FROM users'))).toDB();

    expect(result.expression).to.eq('CREATE OR REPLACE TEMPORARY VIEW "active_users" ("id","name") WITH (security_invoker = true) AS SELECT id, name FROM users WITH LOCAL CHECK OPTION');
    expect(result.bindings).to.deep.eq([]);
  });

  it('spells definer security as security_invoker = false', () => {
    expect(view((v) => v.security('DEFINER').as(new RawQuery('SELECT 1'))).toDB().expression).to.eq('CREATE VIEW "active_users" WITH (security_invoker = false) AS SELECT 1');
  });

  it('throws for the clauses postgres does not have', () => {
    const raw = new RawQuery('SELECT 1');

    expect(() => view((v) => v.ifNotExists().as(raw)).toDB()).to.throw(MethodNotImplemented, 'postgres does not support IF NOT EXISTS');
    expect(() => view((v) => v.algorithm('MERGE').as(raw)).toDB()).to.throw(MethodNotImplemented, 'ALGORITHM');
  });

  it('inlines select bindings with postgres literals', () => {
    const result = view((v) => v.as((select) => select.from('users').where('age', '>', 18).where('name', `it's`))).toDB();

    expect(result.expression).to.eq(`CREATE VIEW "active_users" AS SELECT * FROM "users" WHERE "age" > 18 AND "name" = 'it''s'`);
  });

  it('writes booleans as TRUE and FALSE', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote(true)).to.eq('TRUE');
    expect(quoter.quote(false)).to.eq('FALSE');
  });

  it('drops a view', () => {
    expect(schema().dropView('active_users').ifExists().toDB().expression).to.eq('DROP VIEW IF EXISTS "active_users"');
  });

  it('leaves a literal `?` inlined into a compiled view untouched, since it carries no bindings', () => {
    const result = view((v) => v.as((select) => select.from('users').where('name', 'what?'))).toDB();

    const sent = toDriverStatement(result.expression as string, result.bindings as unknown[]);

    expect(sent).to.eq(result.expression);
    expect(sent).to.include(`'what?'`);
  });

  it('toDriverStatement rewrites placeholders only when there are bindings', () => {
    expect(toDriverStatement('a = ?', [1])).to.eq('a = $1');
    expect(toDriverStatement("a = 'x?'", [])).to.eq("a = 'x?'");
  });

  it('toDriverStatement never rewrites more placeholders than there are bindings', () => {
    expect(toDriverStatement("a = ? AND b = 'x?'", [1])).to.eq("a = $1 AND b = 'x?'");
  });

  it('escapes an injection attempt and a backslash the same way pg.escapeLiteral does', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote("'; DROP TABLE x; --")).to.eq(`'''; DROP TABLE x; --'`);
    expect(quoter.quote('a\\b')).to.eq(` E'a\\\\b'`);
  });
});
