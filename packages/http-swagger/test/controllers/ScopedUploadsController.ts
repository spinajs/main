import { BasePath, Get, Ok, Param } from '@spinajs/http';

import { ScopedUploadsBase } from '../support/scoped-uploads-base.js';

/**
 * Inherits its routes from an abstract base outside the controllers dirs, under a @BasePath with a placeholder.
 * @tags ScopedUploads
 */
@BasePath('projects/:project/uploads')
export class ScopedUploadsController extends ScopedUploadsBase {
  @Get('summary/all')
  public async summary(@Param() project: string) {
    return new Ok({ project });
  }
}
