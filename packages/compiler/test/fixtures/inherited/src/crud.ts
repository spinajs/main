import { BaseController, BasePath, Body, Get, Head, Ok, Param, Policy, Post } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import type { BasePolicy } from '@spinajs/http';

export declare class TenantPolicy implements BasePolicy { isEnabled(): boolean; execute(): Promise<void> }

export type ArticleDto = { id: number; title: string };
export type CreateArticleDto = { title: string };
export type TagDto = { id: number; label: string };
export type CreateTagDto = { label: string };

@Policy(TenantPolicy)
@Access('crud:use')
export abstract class BaseCrud<T, C> extends BaseController {
  @Head(':id')
  public exists(@Param() id: number): Promise<Ok<null>> {
    return Promise.resolve(new Ok(null, { StatusCode: id > 0 ? 200 : 404 }));
  }

  @Get(':id')
  public get(@Param() id: number): Promise<Ok<T>> {
    return this.load(id).then((v) => new Ok(v));
  }

  @Post()
  public create(@Body() dto: C): Promise<Ok<T>> {
    return this.save(dto).then((v) => new Ok(v));
  }

  @Get()
  public health(): Promise<Ok<{ ok: boolean }>> {
    return Promise.resolve(new Ok({ ok: true }));
  }

  protected abstract load(id: number): Promise<T>;
  protected abstract save(dto: C): Promise<T>;
}

@BasePath('shared')
export abstract class PathOnlyBase extends BaseController {}
