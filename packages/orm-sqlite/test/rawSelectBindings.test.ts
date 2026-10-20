/* eslint-disable prettier/prettier */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { RawQuery } from '@spinajs/orm';
import { db } from './common.js';
import { bootUow, registerUowConnection, UowTag } from './uowFixture.js';

const expect = chai.expect;

describe('raw select columns with bindings on sqlite', function () {
  this.timeout(10000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('binds the value of a CASE WHEN column', async () => {
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });

    const out = (await db()
      .Connections.get('sqlite')!
      .select()
      .select(RawQuery.create('CASE WHEN Name = ? THEN 1 ELSE 0 END AS is_red', ['red']))
      .select('Name')
      .from('uow_tag')
      .asRaw<any[]>()) as { Name: string; is_red: number }[];

    expect(Object.fromEntries(out.map((r) => [r.Name, r.is_red]))).to.deep.equal({ red: 1, blue: 0 });
  });
});
