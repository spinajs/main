import { BasePath } from '@spinajs/http';

import type { UploadLimits } from '../../../src/index.js';
import type { UploadSession } from '../../../src/index.js';
import { TestUploadController } from './TestUploadController.js';

/** Server-side misconfigurations: they must answer upload.internal, never a client 400. */
@BasePath('misconfigured/dir/uploads')
export class BadFileDirUploadController extends TestUploadController {
  protected fileDir(_session: UploadSession): string {
    return 'a/../b';
  }
}

@BasePath('misconfigured/ttl/uploads')
export class ZeroTtlUploadController extends TestUploadController {
  protected async limitsFor(): Promise<Partial<UploadLimits>> {
    return { sessionTtl: '0s' };
  }
}
