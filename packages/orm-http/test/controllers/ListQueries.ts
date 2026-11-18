import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Aggregate, Include } from '../../src/decorators.js';
import { FromModel } from '../../src/index.js';
import { IAggregateRequest } from '../../src/interfaces.js';
import { readAggregateRows } from '../../src/aggregate.js';
import { Customer, Order } from '../list-fixture.js';

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

  @Get('customers/aggregate')
  public async customerAggregate(@Aggregate(Customer) aggregate: IAggregateRequest) {
    const rows = await Customer.query().aggregate(aggregate).asRaw<Record<string, unknown>[]>();
    return new Ok({ aggregates: readAggregateRows(rows, aggregate) });
  }

  @Get('orders')
  public async orders(@Include(Order) include: string[]) {
    const query = Order.query().order('Id');
    if (include.length > 0) {
      query.populate(include);
    }
    const rows = await query;
    return new Ok(rows.map((row) => row.dehydrateWithRelations()));
  }

  // `_include` hands @FromModel the request's `include`, as in Simple.testInclude.
  @Get('orders/:order')
  public one(@FromModel() order: Order, @Query() _include: string) {
    return new Ok(order.dehydrateWithRelations());
  }
}
