import { Schema, type StandardSchemaV1 } from '@spinajs/validation';
import { BaseController, BasePath, Body, BodyField, Get, Ok, Post, Query, QueryField, Req, type Request } from '../../../src/index.js';

export class CreateItem {
  public name: string;
  public count: number;
  public tags?: string[];

  constructor(data: Partial<CreateItem>) {
    Object.assign(this, data);
  }
}

const LOOSE_ITEM_SCHEMA = { $id: 'manifest-validation.loose-item', type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

@Schema(LOOSE_ITEM_SCHEMA)
export class LooseItem {
  public name: string;
  public count: number;

  constructor(data: Partial<LooseItem>) {
    Object.assign(this, data);
  }
}

const nameOnly: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: (value) => (typeof (value as { name?: unknown })?.name === 'string' ? { value } : { issues: [{ message: 'name must be a string', path: ['name'] }] }),
  },
};

@Schema(nameOnly)
export class StandardItem {
  public name: string;
  public count: number;

  constructor(data: Partial<StandardItem>) {
    Object.assign(this, data);
  }
}

const base = () => ({ type: 'object' });

@Schema({ ...base(), $id: 'manifest-validation.partial-item', properties: { name: { type: 'string' } } })
export class PartialItem {
  public name: string;

  constructor(data: Partial<PartialItem>) {
    Object.assign(this, data);
  }
}

export class Envelope {
  public item: PartialItem;
  public note?: string;

  constructor(data: Partial<Envelope>) {
    Object.assign(this, data);
  }
}

/** Assigns every key it is given, as ORM `ModelBase.hydrate()` does. */
export class HydratedRecord {
  [key: string]: unknown;

  public hydrate(data: object): void {
    Object.assign(this, data);
  }
}

export type Named = { name: string };
export type Counted = { count: number };

export interface SearchQuery {
  page: number;
  term?: string;
  exact?: boolean;
}

@BasePath('manifest-validation')
export class ManifestValidationController extends BaseController {
  @Post()
  public create(@Body() item: CreateItem) {
    return new Ok({ name: item.name, count: item.count });
  }

  @Post()
  public loose(@Body() item: LooseItem) {
    return new Ok({ name: item.name });
  }

  @Post()
  public standard(@Body() item: StandardItem) {
    return new Ok({ name: item.name });
  }

  @Post()
  public envelope(@Body() envelope: Envelope) {
    return new Ok({ name: envelope.item.name });
  }

  @Post()
  public assign(@Body() item: CreateItem, @Req() req: Request) {
    const record = new HydratedRecord();
    record.hydrate(item);
    return new Ok({ dto: Object.keys(item), model: Object.keys(record), reauthPassword: (req.body as Record<string, unknown>).reauthPassword ?? null });
  }

  @Post()
  public assignFields(@BodyField() item: CreateItem, @Req() req: Request) {
    return new Ok({ dto: Object.keys(item), reauthPassword: (req.body as Record<string, unknown>).reauthPassword ?? null });
  }

  @Post()
  public both(@Body() body: Named & Counted) {
    return new Ok({ name: body.name, count: body.count });
  }

  @Post()
  public pair(@Body() first: Named, @Body() second: Counted) {
    return new Ok({ name: first.name, count: second.count });
  }

  @Get()
  public search(@QueryField() query: SearchQuery) {
    return new Ok({ page: query.page, pageType: typeof query.page, exact: query.exact ?? null });
  }

  @Get()
  public sorted(@Query() sort: 'asc' | 'desc', @Query() limit?: number) {
    return new Ok({ sort, limit: limit ?? null });
  }
}
