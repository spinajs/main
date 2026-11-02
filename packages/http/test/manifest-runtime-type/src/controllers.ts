import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { Autoinject } from '@spinajs/di';
import { DateTime } from 'luxon';
import { BaseController, BasePath, Body, Get, Ok, Param, Parameter, ParameterType, Post, Query, Req, RequestStream, Route, Type } from '../../../src/index.js';
import { Counter, CreateUserDto } from './dto.js';

// Built like orm-http's `@Filter` and authn's `@CurrentUser`: the compiler does not know its name.
const Page = () => Route(Parameter(ParameterType.FromQuery));

@BasePath('runtime-type')
export class RuntimeTypeController extends BaseController {
  @Autoinject()
  protected Counter: Counter;

  @Get(':id')
  public get(@Param() id: number) {
    return new Ok({ id, type: typeof id, injected: this.Counter.kind });
  }

  @Post()
  public create(@Body() dto: CreateUserDto) {
    return new Ok({ hydrated: dto instanceof CreateUserDto, name: dto.name });
  }

  @Get('paged/list')
  public paged(@Page() page: number) {
    return new Ok({ page, type: typeof page });
  }
}

@BasePath('unnamed')
export class UnnamedTypesController extends BaseController {
  @Post()
  public upload(@RequestStream() body: Readable) {
    return new Ok({ stream: typeof body.on });
  }

  @Get()
  public request(@Req() req: IncomingMessage) {
    return new Ok({ method: req.method });
  }
}

@BasePath('since')
export class UntypableController extends BaseController {
  @Get()
  public since(@Query() when: DateTime) {
    return new Ok({ year: when.year });
  }
}

@BasePath('named')
export class NamedTypeController extends BaseController {
  @Get()
  public since(@Query() @Type(DateTime) when: DateTime) {
    return new Ok({ year: when.year });
  }
}

export abstract class CrudController extends BaseController {
  @Get(':id')
  public get(@Param() id: number) {
    return new Ok({ id, type: typeof id });
  }

  @Post()
  public create(@Body() dto: CreateUserDto) {
    return new Ok({ hydrated: dto instanceof CreateUserDto, name: dto.name });
  }
}

@BasePath('crud')
export class ConcreteCrudController extends CrudController {}

@BasePath('pkg-user')
export class PkgUserController extends BaseController {
  @Get('refresh/:id')
  public refresh(@Param() id: number) {
    return new Ok({ from: 'pkg', id, type: typeof id });
  }

  @Get('grants/:page')
  public grants(@Param() page: number) {
    return new Ok({ from: 'pkg', page, type: typeof page });
  }
}

@BasePath('app-user')
export class AppUserController extends PkgUserController {
  @Get('grants/v2/:page')
  public grants(@Param() page: number) {
    return new Ok({ from: 'app', page, type: typeof page });
  }
}
