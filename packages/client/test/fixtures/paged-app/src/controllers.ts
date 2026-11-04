import { BaseController, BasePath, Body, Get, Ok, Post, Query, QueryField } from '@spinajs/http';
import type { CursorPage, CursorQuery, Page, PageQuery } from '@spinajs/http';

export interface UserDto { id: number; name: string }
export interface CreateUserDto { name: string }
export type ListQuery = { search?: string };

export interface ZeroBasedQuery {
  /** @minimum 0 */
  page: number;
  perPage?: number;
}

export interface TagDto { name: string }

/** The server clamps every page to this size, whatever the client asks for. */
export const MAX_PAGE_SIZE = 2;

export const users: UserDto[] = [];

export function resetUsers(count: number): void {
  users.splice(0, users.length, ...Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `user ${i + 1}` })));
}

function slice<T>(items: T[], index: number, size: number | undefined): Page<T> {
  const clamped = Math.min(size ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  return { items: items.slice(index * clamped, (index + 1) * clamped), total: items.length };
}

function after<T>(items: T[], cursor: string | undefined, size: number | undefined, id: (item: T) => string): CursorPage<T> {
  const start = cursor === undefined ? 0 : items.findIndex((item) => id(item) === cursor) + 1;
  const page = items.slice(start, start + Math.min(size ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE));
  return { items: page, next: start + page.length < items.length ? id(page[page.length - 1]) : null };
}

@BasePath('users')
export class UsersController extends BaseController {
  @Get()
  public async list(@Query() query: ListQuery & PageQuery): Promise<Ok<Page<UserDto>>> {
    return new Ok(slice(users, (query.page ?? 1) - 1, query.pageSize));
  }

  @Get()
  public async zero(@QueryField() query: ZeroBasedQuery): Promise<Ok<Page<UserDto>>> {
    // A whole query reaches the handler as the query string's own text.
    return new Ok(slice(users, Number(query.page), query.perPage === undefined ? undefined : Number(query.perPage)));
  }

  @Get()
  public async feed(@Query() cursor?: string, @Query() pageSize?: number): Promise<Ok<CursorPage<UserDto>>> {
    return new Ok(after(users, cursor, pageSize, (u) => String(u.id)));
  }

  /** A page with no page parameter: no infinite hook. */
  @Get()
  public async everyone(): Promise<Ok<Page<UserDto>>> {
    return new Ok({ items: users, total: users.length });
  }

  @Post()
  public async create(@Body() body: CreateUserDto): Promise<Ok<UserDto>> {
    const user = { id: users.length + 1, name: body.name };
    users.unshift(user);
    return new Ok(user);
  }
}

const TAGS: TagDto[] = ['a', 'b', 'c'].map((name) => ({ name }));

@BasePath('tags')
export class TagsController extends BaseController {
  @Get()
  public async list(@Query() query: CursorQuery): Promise<Ok<CursorPage<TagDto>>> {
    return new Ok(after(TAGS, query.cursor, query.pageSize, (t) => t.name));
  }
}
