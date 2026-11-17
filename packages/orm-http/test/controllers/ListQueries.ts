import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Aggregate } from '../../src/decorators.js';
import { IAggregateRequest } from '../../src/interfaces.js';
import { readAggregateRows } from '../../src/aggregate.js';
import { Order } from '../list-fixture.js';

@BasePath('lq')
export class ListQueries extends BaseController {
  @Get('aggregate')
  public async aggregate(@Aggregate(Order) aggregate: IAggregateRequest) {
    if (!aggregate) {
      return new Ok({ aggregates: null });
    }
    const rows = await Order.query().aggregate(aggregate).asRaw<Record<string, unknown>[]>();
    return new Ok({ aggregates: readAggregateRows(rows, aggregate) });
  }
}
