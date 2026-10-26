import { BaseController, BasePath, Get } from '@spinajs/http';

import { UploadError } from '../../../src/index.js';

/** An app route that uses the upload service outside UploadController: its UploadErrors reach the framework error map. */
@BasePath('service-routes')
export class ServiceRoutesController extends BaseController {
  @Get()
  public missing() {
    throw new UploadError('upload.not_found', 'upload 42 not found');
  }

  @Get()
  public partsMissing() {
    throw new UploadError('upload.parts_missing', 'parts 2 and 3 are missing', { parts: [2, 3] });
  }
}
