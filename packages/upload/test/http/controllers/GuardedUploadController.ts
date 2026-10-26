import { BasePath, HTTP_STATUS_CODE, Json, OnError, answeredAsServerError } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { UploadController } from '../../../src/http/index.js';
import type { UploadAction } from '../../../src/http/index.js';
import { Seen } from '../support/calls.js';

/** The subclass handler of docs/upload/04 tip 8: it answers server errors only, so the base still answers the rest. */
@BasePath('guarded/uploads')
@OnError(Error, (err) => {
  const server = answeredAsServerError(err);
  Seen.guarded.push({ name: err.constructor.name, server });
  return server ? new Json({ code: 'app.failed', message: 'Failed' }, { StatusCode: HTTP_STATUS_CODE.INTERNAL_ERROR }) : undefined;
})
export class GuardedUploadController extends UploadController {
  protected async authorize(_action: UploadAction, req: Request): Promise<void> {
    if (req.headers['x-test-boom']) throw new Error('boom');
  }
}
