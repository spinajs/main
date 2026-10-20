import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { ICompilerOutput, RawQuery } from '@spinajs/orm';

import { PostgresOrmDriver } from '../src/index.js';

describe('postgres database now', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-now-test', Driver: 'orm-driver-postgres' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('is CURRENT_TIMESTAMP, usable as a where value', () => {
    const out = driver.select().from('t').where('At', '<=', driver.now()).toDB() as ICompilerOutput;

    expect(driver.now().Query).to.eq('CURRENT_TIMESTAMP');
    expect(out.expression).to.contain('"At" <= CURRENT_TIMESTAMP');
    expect(out.bindings).to.deep.eq([]);
  });

  it('carries the bindings of a raw where value', () => {
    const out = driver.select().from('t').where('At', '>', RawQuery.create('CURRENT_TIMESTAMP - make_interval(days => ?)', [7])).toDB() as ICompilerOutput;

    expect(out.expression).to.contain('"At" > CURRENT_TIMESTAMP - make_interval(days => ?)');
    expect(out.bindings).to.deep.eq([7]);
  });
});
