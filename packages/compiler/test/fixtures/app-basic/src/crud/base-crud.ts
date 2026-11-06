import { BaseController, Body, Get, Ok, Param, Post } from '@spinajs/http';

export abstract class BaseCrudController<T, C> extends BaseController {
  /** Read one item. */
  @Get(':id')
  public async read(@Param() id: number): Promise<Ok<T>> {
    return new Ok(await this.find(id));
  }

  @Post()
  public async add(@Body() body: C): Promise<Ok<T>> {
    return new Ok(await this.insert(body));
  }

  protected abstract find(id: number): Promise<T>;
  protected abstract insert(body: C): Promise<T>;
}
