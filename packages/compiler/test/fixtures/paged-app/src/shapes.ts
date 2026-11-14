import { BasePath, Get, NotFound, Ok, Query } from '@spinajs/http';
import type { CursorPage, Page, PageQuery } from '@spinajs/http';
import type { UserDto } from './users.js';

/** An app's own name for a page: TypeScript re-aliases the type, so `aliasSymbol` is `UserPage`, not `Page`. */
export type UserPage = Page<UserDto>;

@BasePath('shapes')
export class ShapesController {
  @Get()
  public named(@Query() page?: number): Promise<Ok<UserPage>> {
    return Promise.resolve(new Ok({ items: [], total: page ?? 0 }));
  }

  @Get()
  public frozen(@Query() cursor?: string): Promise<Ok<Readonly<CursorPage<UserDto>>>> {
    return Promise.resolve(new Ok({ items: [], next: cursor ?? null }));
  }

  @Get()
  public faceted(@Query() page?: number): Promise<Ok<Page<UserDto> & { facets: string[] }>> {
    return Promise.resolve(new Ok({ items: [], total: page ?? 0, facets: [] }));
  }

  @Get()
  public exclusive(@Query({ type: 'integer', exclusiveMinimum: -1 }) page: number): Promise<Page<UserDto>> {
    return Promise.resolve({ items: [], total: page });
  }

  @Get()
  public referenced(@Query({ type: 'object', properties: { page: { $ref: 'spinajs/paged-app/ShapesController.exclusive.page' } } }) query: PageQuery): Promise<Page<UserDto>> {
    return Promise.resolve({ items: [], total: query.page ?? 0 });
  }

  @Get()
  public maybe(@Query() page?: number): Promise<Ok<Page<UserDto>> | NotFound> {
    return Promise.resolve(page === 0 ? new NotFound({}) : new Ok({ items: [], total: 0 }));
  }
}
