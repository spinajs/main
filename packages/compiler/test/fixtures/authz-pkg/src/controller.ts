import { BaseController, BasePath, Get, Post } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';

@BasePath('docs')
@Access('doc:read')
export class DocsController extends BaseController {
  @Get(':id')
  public async get(): Promise<void> {}

  // spinajs-authz-ignore AUTHZ001: the export reads every document on purpose
  @Post()
  @Access('doc:create')
  public async create(): Promise<void> {}
}
