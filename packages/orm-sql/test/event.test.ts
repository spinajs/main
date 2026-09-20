import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { DateTime } from 'luxon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DeleteQueryBuilder, EventQueryBuilder, Orm, QueryContext, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection() {
  return DI.get(Orm)!.Connections.get('sqlite')!;
}

function schqb() {
  return connection().Container.resolve(SchemaQueryBuilder, [connection()]);
}

function dqb() {
  return connection().Container.resolve(DeleteQueryBuilder, [connection()]);
}

describe('database events', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const purge = new RawQuery('DELETE FROM sessions');
  const event = (build: (event: EventQueryBuilder) => void) => schqb().createEvent('purge', build);

  it('returns a chainable schema builder', () => {
    const builder = event((e) => e.every(1, 'HOUR').do(purge));

    expect(builder).to.be.instanceOf(EventQueryBuilder);
    expect(builder.QueryContext).to.eq(QueryContext.Schema);
  });

  it('compiles a recurring event with explicit defaults', () => {
    const result = event((e) => e.every(5, 'MINUTE').do(purge)).toDB();

    expect(result.expression).to.eq(['CREATE EVENT `purge`', 'ON SCHEDULE EVERY 5 MINUTE', 'ON COMPLETION NOT PRESERVE', 'ENABLE', 'DO DELETE FROM sessions'].join('\n'));
    expect(result.bindings).to.deep.eq([]);
  });

  it('compiles every clause', () => {
    const result = event((e) =>
      e
        .database('app')
        .ifNotExists()
        .every(1, 'WEEK')
        .starts(DateTime.fromSQL('2026-03-13 23:00:00'))
        .ends(DateTime.fromSQL('2027-03-13 23:00:00'))
        .preserve()
        .disabled()
        .comment(`friday's purge`)
        .do(purge),
    ).toDB();

    expect(result.expression).to.eq(
      ['CREATE EVENT IF NOT EXISTS `app`.`purge`', "ON SCHEDULE EVERY 1 WEEK STARTS '2026-03-13 23:00:00.000' ENDS '2027-03-13 23:00:00.000'", 'ON COMPLETION PRESERVE', 'DISABLE', "COMMENT 'friday''s purge'", 'DO DELETE FROM sessions'].join('\n'),
    );
  });

  it('compiles a one shot event at a point in time', () => {
    const result = event((e) => e.at(DateTime.fromSQL('2026-01-01 00:00:00')).do(purge)).toDB();

    expect(result.expression).to.contain("ON SCHEDULE AT '2026-01-01 00:00:00.000'\n");
  });

  it('compiles a one shot event relative to now', () => {
    const result = event((e) => e.fromNow(1, 'DAY').do(purge)).toDB();

    expect(result.expression).to.contain('ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY\n');
  });

  it('emits a single builder action as it is, with its bindings inlined', () => {
    const result = event((e) => e.every(1, 'DAY').do(dqb().from('sessions').where('CreatedAt', '<', '2026-01-01'))).toDB();

    expect(result.expression).to.match(/DO DELETE FROM `sessions` WHERE `CreatedAt` < '2026-01-01'$/);
  });

  it('wraps several actions in BEGIN ... END, one statement per line', () => {
    const result = event((e) => e.every(1, 'DAY').do([new RawQuery('TRUNCATE TABLE a;'), new RawQuery('DELETE FROM b WHERE id > ?', [10])])).toDB();

    expect(result.expression).to.match(/DO BEGIN\nTRUNCATE TABLE a;\nDELETE FROM b WHERE id > 10;\nEND$/);
  });

  it('leaves a raw body that brings its own block untouched', () => {
    const block = 'BEGIN\n  UPDATE t SET a = 1; -- note\n  UPDATE t SET b = 2;\nEND';
    const result = event((e) => e.every(1, 'DAY').do(new RawQuery(block))).toDB();

    expect(result.expression!.endsWith(`DO ${block}`)).to.eq(true);
  });

  it('refuses a second schedule', () => {
    expect(() => event((e) => e.every(1, 'DAY').at(DateTime.now()))).to.throw(InvalidOperation, /mutually exclusive/);
    expect(() => event((e) => e.fromNow(1, 'DAY').every(1, 'DAY'))).to.throw(InvalidOperation, /mutually exclusive/);
  });

  it('refuses a bad interval', () => {
    expect(() => event((e) => e.every(0, 'DAY'))).to.throw(InvalidArgument);
    expect(() => event((e) => e.every(1.5, 'DAY'))).to.throw(InvalidArgument);
    expect(() => event((e) => e.every(1, 'FORTNIGHT' as any))).to.throw(InvalidArgument);
  });

  it('refuses to compile without a schedule, without a body, or with starts on a one shot event', () => {
    expect(() => event((e) => e.do(purge)).toDB()).to.throw(InvalidOperation, /no schedule/);
    expect(() => event((e) => e.every(1, 'DAY')).toDB()).to.throw(InvalidOperation, /no body/);
    expect(() => event((e) => e.fromNow(1, 'DAY').starts(DateTime.now()).do(purge)).toDB()).to.throw(InvalidOperation, /only valid with every/);
  });

  it('drops an event, with IF EXISTS only when asked', () => {
    expect(schqb().dropEvent('purge').toDB().expression).to.eq('DROP EVENT `purge`');
    expect(schqb().dropEvent('purge').ifExists().toDB().expression).to.eq('DROP EVENT IF EXISTS `purge`');
  });
});
