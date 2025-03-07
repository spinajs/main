import { Schema } from '@spinajs/validation';

@Schema({
  type: 'object',
  $id: 'arrow.common.PaginationDTO',
  properties: {
    limit: { type: 'number', minimum: 0 },
    offset: { type: 'number', minimum: 0 },
    take: { type: 'number', minimum: 0 },
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
    order: { type: 'string', enum: ['ASC', 'DESC','asc','desc'] },
    column: { type: 'string' },
  },
})
export class OrderDTO {
  public order: 'ASC' | 'DESC';
  public column: string;

  constructor(data: Partial<OrderDTO>) {
    Object.assign(this, data);
  }
}
