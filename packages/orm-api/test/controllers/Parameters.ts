import { BaseController, Get, Ok, BasePath, Query } from '@spinajs/http';
import { QueryFilter } from '../../src/dto/QueryFilter.js';

@BasePath('parameters')
export class Parameters extends BaseController {
  @Get('filter')
  public filter(@Query() filter: QueryFilter) {
    return new Ok(filter);
  }
}
