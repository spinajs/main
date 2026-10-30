import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Body, Get, Ok, Param, Post } from '../../../src/index.js';
import { Counter, CreateUserDto } from './dto.js';

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
}
