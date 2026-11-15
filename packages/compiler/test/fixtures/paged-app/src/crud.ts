import { BaseController, BasePath, Get, NotFound, Ok, Query } from '@spinajs/http';
import type { Page, PageQuery } from '@spinajs/http';

export interface ArticleDto { id: number; title: string }

export abstract class BaseCrud<T> extends BaseController {
  @Get()
  public list(@Query() query: PageQuery): Promise<Ok<Page<T>>> {
    return this.load(query.page ?? 1).then((items) => new Ok({ items, total: items.length }));
  }

  @Get()
  public maybe(@Query() page?: number): Promise<Ok<Page<T>> | NotFound> {
    return this.load(page ?? 1).then((items) => (items.length ? new Ok({ items, total: items.length }) : new NotFound({})));
  }

  protected abstract load(page: number): Promise<T[]>;
}

@BasePath('articles')
export class ArticlesController extends BaseCrud<ArticleDto> {
  protected load(): Promise<ArticleDto[]> { return Promise.resolve([]); }
}
