import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { KeysetPaginationDTO, KeysetQuery } from './../../src/index.js';
import { Test } from '../models/Test.js';

@BasePath('keyset')
export class KeysetC extends BaseController {
  @Get()
  public async tests(@KeysetQuery() page: KeysetPaginationDTO) {
    return new Ok(await Test.select().paginate({ orderBy: [['Id', 'asc']], limit: page.limit, after: page.after, before: page.before }));
  }
}
