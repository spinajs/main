import { BaseController, BasePath, Get, Public } from '@spinajs/http';
import { Access, AllowAnonymous, fromModel, fromParam, typedExtractor } from '@spinajs/authz-http';
import { Note } from './models.js';

@BasePath('open')
export class OpenController extends BaseController {
  @Get('health')
  @Public('load balancer probe')
  public async health(): Promise<void> {}

  @Get('ping')
  @AllowAnonymous()
  public async ping(): Promise<void> {}

  @Get('note/:id')
  @AllowAnonymous()
  @Access('doc:read', { resource: fromParam('id', 'doc') })
  public async note(): Promise<void> {}

  @Get('model/:id')
  @Access('doc:update', { resource: fromModel(Note, 'id') })
  public async model(): Promise<void> {}

  @Get('typed/:id')
  @Access('report:run', { resource: typedExtractor('report', () => ({ type: 'report' })) })
  public async typed(): Promise<void> {}
}
