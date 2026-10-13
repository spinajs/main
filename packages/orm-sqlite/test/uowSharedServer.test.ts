/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import _ from 'lodash';
import { QueryContext } from '@spinajs/orm';
import { SqliteOrmDriver } from '../src/index.js';
import { TEST_MIGRATION_TABLE_NAME } from './common.js';
import { mergeArrays } from './util.js';
import { bootUow, captureStatements, rows, UowOrder, UowOrderItem } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * `sqlite` and `sqlite-shared` declare one server; `sqlite-alone` does not. sqlite has no schemas,
 * so a row routed through `sqlite` lands in its own database - which is what proves the routing:
 * the tables exist only there.
 */
class SharedServerConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
        db: {
          Connections: [
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', SharedServer: 'memory', Migration: { Table: TEST_MIGRATION_TABLE_NAME } },
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite-shared', SharedServer: 'memory' },
            { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite-alone' },
          ],
        },
      },
      mergeArrays,
    );
  }
}

/** Runs `fn` with the order items declared on `connection`. */
async function itemsOn<T>(connection: string, fn: () => Promise<T>): Promise<T> {
  const descriptor = UowOrderItem.getModelDescriptor();
  const previous = descriptor.Connection;
  descriptor.Connection = connection;
  try {
    return await fn();
  } finally {
    descriptor.Connection = previous;
  }
}

function orderWithItems() {
  const order = new UowOrder({ Total: 1 });
  order.attach(new UowOrderItem({ Sku: 'A', Qty: 1 }));
  order.attach(new UowOrderItem({ Sku: 'B', Qty: 2 }));
  return order;
}

describe('ModelBase.save - connections on one server', function () {
  this.timeout(10000);

  before(() => {
    DI.register(SharedServerConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('writes the rows of another connection on the same server through the root transaction', async () => {
    const order = orderWithItems();

    const capture = captureStatements();
    await itemsOn('sqlite-shared', () => order.save());
    capture.restore();

    expect(capture.statements.filter((s) => s.context === QueryContext.Insert || s.context === QueryContext.InsertReturning)).to.have.length(3);
    expect((await rows('uow_order_item')).map((r) => [r.Sku, r.order_id])).to.deep.equal([
      ['A', order.Id],
      ['B', order.Id],
    ]);
  });

  it('rolls the rows of both connections back together', async () => {
    const order = orderWithItems();
    const driver: any = (UowOrder as any).driver();
    const original = driver.execute.bind(driver);
    let seen = 0;
    driver.execute = async (builder: any) => {
      seen += 1;
      if (seen === 3) {
        throw new Error('boom');
      }
      return await original(builder);
    };

    try {
      await itemsOn('sqlite-shared', async () => {
        await expect(order.save()).to.be.rejectedWith('boom');
      });
    } finally {
      driver.execute = original;
    }

    expect(await rows('uow_order')).to.have.length(0);
    expect(await rows('uow_order_item')).to.have.length(0);
  });

  it('still refuses a connection that declares no shared server', async () => {
    await itemsOn('sqlite-alone', async () => {
      await expect(orderWithItems().save()).to.be.rejectedWith(/connection/);
    });
  });
});
