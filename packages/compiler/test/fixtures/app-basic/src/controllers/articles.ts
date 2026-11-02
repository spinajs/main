import { BasePath } from '@spinajs/http';
import { AllowAnonymous } from '@spinajs/authz-http';
import { BaseCrudController } from '../crud/base-crud.js';

export type ArticleDto = { id: number; title: string };
export type CreateArticleDto = { title: string };

// No @Access: the boot e2e runs without a principal, and @Access answers 401 before validation.
@BasePath('articles')
@AllowAnonymous()
export class ArticlesController extends BaseCrudController<ArticleDto, CreateArticleDto> {
  protected find(id: number): Promise<ArticleDto> {
    return Promise.resolve({ id, title: `article ${id}` });
  }

  protected insert(body: CreateArticleDto): Promise<ArticleDto> {
    return Promise.resolve({ id: 2, ...body });
  }
}
