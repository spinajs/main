import { DI } from '@spinajs/di';
import type { ISelectQueryBuilder, IWhereBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { bootUow, captureStatements, registerUowConnection, UowClient, UowOrder } from './uowFixture.js';

const ids = (rows: UowOrder[]) => rows.map((r) => r.Id);

function nameIsNone(this: IWhereBuilder<UowClient>) {
  this.where('Name', 'none');
}

function orNameIsVip(this: ISelectQueryBuilder<UowClient>) {
  this.orWhere('Name', 'vip');
}

describe('join callback conditions', function () {
  this.timeout(30000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowClient.insert({ Name: 'vip' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrder.insert({ Total: 20, client_id: 2 });
    await UowOrder.insert({ Total: 30, client_id: 1 });
  });

  afterEach(() => DI.clearCache());

  it('an orWhere in a join query callback does not join a VIP customer to every order', async () => {
    const capture = captureStatements();
    const rows = await UowOrder.select().order('Id').innerJoin('Client', nameIsNone, orNameIsVip);
    capture.restore();

    expect(ids(rows)).to.deep.equal([2]);
    expect(capture.statements[0].expression).to.contain('ON `$uow_order$`.`client_id` = `$UowClient$`.`Id` AND ( ( `$UowClient$`.`Name` = ? ) OR `$UowClient$`.`Name` = ? )');
  });

  it('a left join keeps every order and matches the VIP customer only on its own order', async () => {
    const rows = await UowOrder.select()
      .select('Id')
      .order('Id')
      .leftJoin('Client', nameIsNone, function (this: ISelectQueryBuilder<UowClient>) {
        this.select('Name').orWhere('Name', 'vip');
      })
      .asRaw<{ Id: number; Name: string | null }[]>();

    expect(rows.map((r) => [r.Id, r.Name])).to.deep.equal([
      [1, null],
      [2, 'vip'],
      [3, null],
    ]);
  });

  it('an orWhere in a join callback stays inside ON', async () => {
    const rows = await UowOrder.select()
      .order('Id')
      .innerJoin('Client', function (this: IWhereBuilder<UowClient>) {
        this.where('Name', 'none').orWhere('Name', 'vip');
      });

    expect(ids(rows)).to.deep.equal([2]);
  });
});
