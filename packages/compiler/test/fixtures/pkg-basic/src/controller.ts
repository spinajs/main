import { BaseController, BasePath, Get, Post, Del, Body, Query, Param, Policy, Middleware, Ok, BasePolicy, RouteMiddleware } from '@spinajs/http';
import { Access, AllowAnonymous } from '@spinajs/authz-http';

export class UserDto { public id: number; public name: string }
export class CreateUserDto { public name: string; public email?: string }
export class AdminPolicy extends BasePolicy { public isEnabled(): boolean { return true; } public async execute(): Promise<void> {} }
export class Audit extends RouteMiddleware { public isEnabled(): boolean { return true; } public async onBefore(): Promise<void> {} public async onAfter(): Promise<void> {} public async onResponse(): Promise<void> {} }

/** Users of the system. */
@BasePath('users')
@Policy(AdminPolicy, 'strict')
@Middleware(Audit)
export class UsersController extends BaseController {
  /**
   * @summary Get one user
   * @tags users
   * @response 404 not found
   */
  @Get(':id')
  @Access('user:read')
  public async get(@Param() id: number, @Query() verbose?: boolean): Promise<Ok<UserDto>> {
    return new Ok({ id, name: String(verbose) });
  }

  @Post()
  @Access(['user:create', 'user:update'], { fields: 'filter' })
  public async create(@Body({ required: true }) body: CreateUserDto): Promise<UserDto> {
    return { id: 1, name: body.name };
  }

  @Del(':id')
  @AllowAnonymous()
  @Policy([AdminPolicy, 'policies.admin'])
  public async remove(@Param({ type: 'number', minimum: 1 }) id: number): Promise<void> { void id; }

  @Get()
  public async list(): Promise<Ok<UserDto[]>> {
    return new Ok([]);
  }

  @Get('ping')
  public ping(): Ok {
    return new Ok();
  }
}
