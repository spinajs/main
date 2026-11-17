import { BaseController, BasePath, Get, Ok, Parameter, Route } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

const MODEL_DESCRIPTOR_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');

/** Stand-in for an orm model with orm-http's list allow-lists filled in, as FilterController.ts does for filters. */
export class ListedOrder {}

Reflect.defineMetadata(
  MODEL_DESCRIPTOR_SYMBOL,
  {
    Name: 'ListedOrder',
    TableName: 'orders',
    Columns: [],
    GroupableColumns: new Set<string>(['status', 'customerId']),
    AggregatableColumns: new Map<string, string[]>([['amount', ['sum', 'avg']]]),
    IncludableRelations: new Set<string>(['customer']),
  },
  ListedOrder,
);

// orm-http's @Aggregate and @Include are exactly these.
function Aggregate(model: unknown) {
  return Route(Parameter('AggregateModelRouteArg', null, model));
}

function Include(model: unknown) {
  return Route(Parameter('IncludeModelRouteArg', null, model));
}

@Schema({
  $id: 'test.ListedOrderList',
  type: 'object',
  required: ['rows', 'total'],
  properties: {
    rows: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, status: { type: 'string' } } } },
    total: { type: 'integer', minimum: 0 },
    aggregates: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
})
export class ListedOrderListDto {}

/**
 * Demonstrates orm-http's list arguments and a typed list response.
 * @tags ListTests
 */
@BasePath('list')
export class ListController extends BaseController {
  /**
   * List orders
   * @param aggregate Group columns and measures over the filtered rows
   * @param include Relations to load with each row
   * @returns {ListedOrderListDto} One page of rows, the total and the aggregates
   */
  @Get('orders')
  public orders(@Aggregate(ListedOrder) aggregate: unknown, @Include(ListedOrder) include: string[]) {
    return new Ok({ rows: [], total: 0, aggregate, include });
  }
}
