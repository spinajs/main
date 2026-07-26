import { SortOrder } from '@spinajs/orm';
import { Schema } from '@spinajs/validation';

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
  public limit: number;
  public page: number;

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
  public order: SortOrder;
  public column: string;

  constructor(data: Partial<OrderDTO>) {
    Object.assign(this, data);
  }
}
