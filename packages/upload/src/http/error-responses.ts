import type { ActionRefused } from '@spinajs/hooks';
import { HTTP_STATUS_CODE, Json } from '@spinajs/http';

import type { UploadError, UploadErrorDetails } from '../errors.js';

/** What every upload refusal answers with; spec §3 makes every response except HEAD JSON. */
export interface UploadErrorBody {
  code: string;
  message: string;
  details?: UploadErrorDetails;
}

export function uploadErrorBody(err: UploadError): UploadErrorBody {
  return { code: err.code, message: err.message, ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}) };
}

/** `Json`, not the error map: it skips the Accept negotiation, so a browser asking for HTML still gets the JSON body. */
export function uploadErrorResponse(err: UploadError): Json<UploadErrorBody> {
  // HTTP_STATUS_CODE has no 410 or 411 member; the number is sent as it is.
  return new Json(uploadErrorBody(err), { StatusCode: err.status });
}

/** An `upload.create` or `upload.complete` hook refused (hooks/src/errors.ts:4-8): 403 with the hook's own code. */
export function hookRefusalResponse(err: ActionRefused): Json<UploadErrorBody> {
  return new Json({ code: err.code, message: err.message }, { StatusCode: HTTP_STATUS_CODE.FORBIDDEN });
}
