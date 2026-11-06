import { BasePath, Get, Ok, Policy } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';
import { BaseCrud, PathOnlyBase, TenantPolicy, UploadBase, type ArticleDto, type CreateArticleDto, type CreateTagDto, type TagDto } from './crud.js';

@BasePath('articles')
export class ArticlesController extends BaseCrud<ArticleDto, CreateArticleDto> {
  protected load(id: number): Promise<ArticleDto> { return Promise.resolve({ id, title: 't' }); }
  protected save(dto: CreateArticleDto): Promise<ArticleDto> { return Promise.resolve({ id: 1, ...dto }); }
}

@BasePath('tags')
@Access('tags:use')
export class TagsController extends BaseCrud<TagDto, CreateTagDto> {
  @Get('by/:id')
  @Policy(TenantPolicy)
  public get(id: number): Promise<Ok<TagDto>> { return Promise.resolve(new Ok({ id, label: 'x' })); }

  @Get('popular')
  public popular(): Promise<Ok<TagDto[]>> { return Promise.resolve(new Ok([])); }

  protected load(id: number): Promise<TagDto> { return Promise.resolve({ id, label: 'x' }); }
  protected save(dto: CreateTagDto): Promise<TagDto> { return Promise.resolve({ id: 1, ...dto }); }
}

export class SharedController extends PathOnlyBase {
  @Get()
  public ping(): Promise<Ok<string>> { return Promise.resolve(new Ok('pong')); }
}

export class PlainChild extends ArticlesController {}

@BasePath('uploads')
export class UploadsController extends UploadBase<CreateTagDto> {}
