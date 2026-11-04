import { BasePath, Get, Ok, Query, QueryField } from '@spinajs/http';
import type { CursorPage, CursorQuery, Page, PageQuery } from '@spinajs/http';
import type { Page as LocalPage } from './local-page.js';

export interface UserDto { id: number; name: string }
export type ListQuery = { search?: string };

/** Zero-based page, as `orm-http`'s `PaginationDTO` counts. */
export interface ZeroBasedQuery {
  /** @minimum 0 */
  page: number;
  perPage?: number;
}

/** Same shape as the `@spinajs/http` `Page<T>`, declared elsewhere: not a page. */
export type Paged<T> = { items: T[]; total: number };

@BasePath('users')
export class UsersController {
  @Get()
  public list(@Query() query: ListQuery & PageQuery): Promise<Ok<Page<UserDto>>> {
    return Promise.resolve(new Ok({ items: [], total: query.page ?? 0 }));
  }

  @Get('zero')
  public zero(@QueryField() query: ZeroBasedQuery): Promise<Ok<Page<UserDto>>> {
    return Promise.resolve(new Ok({ items: [], total: query.page }));
  }

  @Get('values')
  public values(@Query({ type: 'integer', minimum: 0 }) page: number, @Query() limit?: number): Promise<Page<UserDto>> {
    return Promise.resolve({ items: [], total: page + (limit ?? 0) });
  }

  @Get('feed')
  public feed(@Query() query: CursorQuery): Promise<Ok<CursorPage<UserDto>>> {
    return Promise.resolve(new Ok({ items: [], next: query.cursor ?? null }));
  }

  @Get('after')
  public after(@Query() after?: string): Promise<Ok<CursorPage<{ id: number }>>> {
    return Promise.resolve(new Ok({ items: [], next: after ?? null }));
  }

  @Get('all')
  public all(): Promise<Ok<Page<UserDto>>> {
    return Promise.resolve(new Ok({ items: [], total: 0 }));
  }

  @Get('lookalike')
  public lookalike(@Query() page?: number): Promise<Ok<Paged<UserDto>>> {
    return Promise.resolve(new Ok({ items: [], total: page ?? 0 }));
  }

  @Get('local')
  public local(@Query() page?: number): Promise<Ok<LocalPage<UserDto>>> {
    return Promise.resolve(new Ok({ items: [], total: page ?? 0 }));
  }

  @Get('array')
  public array(): Promise<Ok<UserDto[]>> {
    return Promise.resolve(new Ok([]));
  }
}
