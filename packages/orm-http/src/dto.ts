import { SortOrder } from '@spinajs/orm';
import { Schema } from '@spinajs/validation';
import { IAggregateMeasure, IAggregateRequest } from './interfaces.js';

@Schema({
  type: 'object',
  $id: 'arrow.common.PaginationDTO',
  // Must match the class fields below — otherwise `page` is never validated
  // and offset/take validate phantom properties that the class never declares.
  properties: {
    limit: { type: 'number', minimum: 0 },
    page: { type: 'number', minimum: 0 },
  },
})
export class PaginationDTO {
  // Optional: neither field is `required` in the schema above, so a client may
  // send `{ page: 2 }` (or nothing at all) and the field stays undefined.
  public limit?: number;
  public page?: number;

  constructor(data: Partial<PaginationDTO>) {
    Object.assign(this, data);
  }
}

@Schema({
  type: 'object',
  $id: 'arrow.common.OrderDTO',
  properties: {
    order: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] },
    column: { type: 'string' },
  },
})
export class OrderDTO {
  // Optional for the same reason as PaginationDTO — the schema requires neither.
  public order?: SortOrder;
  public column?: string;

  constructor(data: Partial<OrderDTO>) {
    Object.assign(this, data);
  }
}

/** `?sorting={"by":[{"column":"dueDate","order":"DESC"}]}`: earlier entries win. An object, so the query parameter is one JSON value. */
@Schema({
  type: 'object',
  $id: 'spinajs.orm-http.SortingDTO',
  additionalProperties: false,
  properties: {
    by: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['column'],
        properties: {
          column: { type: 'string', maxLength: 128 },
          order: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] },
        },
      },
    },
  },
})
export class SortingDTO {
  public by: OrderDTO[];

  // The framework builds a DTO also for an absent parameter, so `data` may be undefined.
  constructor(data?: Partial<SortingDTO>) {
    this.by = Array.isArray(data?.by) ? data.by.map((entry) => new OrderDTO(entry)) : ((data?.by as unknown as OrderDTO[]) ?? []);
  }
}

/** `?aggregate={"groupBy":["status"],"measures":[{"name":"total","fn":"sum","column":"amount"}]}`. No `@Schema`: the schema depends on the model, the route argument supplies it. */
export class AggregateDTO implements IAggregateRequest {
  public groupBy?: string[];
  public measures: IAggregateMeasure[];
  public order?: { column?: string; order?: SortOrder }[];
  public limit?: number;

  constructor(data: Partial<AggregateDTO>) {
    Object.assign(this, data);
  }
}

/** One page of a list: declare a subclass per model with `@Schema(listResponseSchema(...))` and name it in `@returns`. */
export class ListResponseDTO<T> {
  public rows: T[];
  /** Rows matching the filter, before paging. */
  public total: number;
  public aggregates?: Record<string, unknown>[];

  constructor(data: Partial<ListResponseDTO<T>>) {
    Object.assign(this, data);
  }
}

/** JSON schema of a list answer whose rows match `row` (a schema object or `{ $ref }`). */
export function listResponseSchema(id: string, row: object, options: { aggregates?: boolean } = {}) {
  return {
    $id: id,
    type: 'object',
    required: ['rows', 'total'],
    properties: {
      rows: { type: 'array', items: row },
      total: { type: 'integer', minimum: 0 },
      ...(options.aggregates !== false && {
        aggregates: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
    },
  };
}
