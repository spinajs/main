import { BaseController, BasePath, Body, File, Get, HandleException, NoContent, NotFound, Ok, Param, Post, Query } from '@spinajs/http';
import type { IUploadedFile } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import { ResourceNotFound } from '@spinajs/exceptions';

export type UserDto = { id: number; email: string; name?: string };
export type CreateUserDto = { email: string; name?: string };
export type ValidationProblem = { kind: 'validation'; errors: string[] };
export type ListQuery = { page?: number; perPage?: number };

const USERS: UserDto[] = [{ id: 1, email: 'ada@example.com', name: 'Ada' }];

@HandleException(ResourceNotFound)
export class UserNotFound extends NotFound {}

@BasePath('users')
export class UsersController extends BaseController {
  /** List users, paginated. */
  @Get()
  public async list(@Query() query: ListQuery): Promise<Ok<UserDto[]>> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 10;
    return new Ok(USERS.slice((page - 1) * perPage, page * perPage));
  }

  @Get(':id')
  @Access('user:read')
  public async get(@Param() id: number): Promise<Ok<UserDto>> {
    const user = USERS.find((u) => u.id === id);
    if (!user) throw new ResourceNotFound(`user ${id}`);
    return new Ok(user);
  }

  @Post()
  @Access('user:create')
  public async create(@Body() body: CreateUserDto): Promise<Ok<UserDto | ValidationProblem>> {
    if (!body.email.includes('@')) return new Ok({ kind: 'validation', errors: ['email'] });
    const user = { id: USERS.length + 1, ...body };
    USERS.push(user);
    return new Ok(user);
  }

  @Post(':id/avatar')
  public async avatar(@Param() id: number, @File() file: IUploadedFile): Promise<NoContent<void>> {
    void id;
    void file;
    return new NoContent<void>(null);
  }
}
