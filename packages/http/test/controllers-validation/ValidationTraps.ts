import { Schema } from '@spinajs/validation';
import { BaseController, BasePath, Body, Get, Ok, Post, Query } from '../../src/index.js';

const PAGE = { type: 'integer', minimum: 1, maximum: 100 };

@Schema({ type: 'object', properties: { page: PAGE } })
export class PageQuery {
  page?: number;

  constructor(data: Partial<PageQuery>) {
    Object.assign(this, data);
  }
}

@Schema({
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'integer', minimum: 0, maximum: 100 },
    tags: { type: 'array', uniqueItems: true },
    meta: { const: { a: 1 } },
    kind: { enum: [{ a: 1 }, 'plain'] },
  },
  required: ['name'],
})
export class TrapItem {
  name: string;
  count?: number;

  constructor(data: Partial<TrapItem>) {
    Object.assign(this, data);
  }
}

const report = (value: unknown) => ({ value: typeof value === 'number' ? String(value) : value, type: typeof value });

@BasePath('validation-traps')
export class ValidationTraps extends BaseController {
  @Get()
  public page(@Query(PAGE) page: number) {
    return new Ok(report(page));
  }

  @Get()
  public pageText(@Query(PAGE) page: string) {
    return new Ok(report(page));
  }

  @Get()
  public pageQuery(@Query() q: PageQuery) {
    return new Ok(report(q.page));
  }

  @Post()
  public pageBody(@Body() q: PageQuery) {
    return new Ok(report(q.page));
  }

  @Post()
  public item(@Body() item: TrapItem) {
    return new Ok({ name: item.name, count: report(item.count) });
  }
}
