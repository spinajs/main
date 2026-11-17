import { AuditWriteFailed } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import { HTTP_STATUS_CODE, HandleException, Response, ServerError } from '@spinajs/http';

/**
 * The answer to a request whose audit record could not be written on a `reject` trail: 503, so a client may retry.
 * A ServerError, so the message is hidden in production like that of any server fault. Registered by the exception's
 * class name: with this package installed an `AuditWriteFailed` from anywhere in a request answers 503.
 */
@HandleException(AuditWriteFailed)
@Injectable(Response)
export class AuditUnavailable<T = unknown> extends ServerError<T> {
  protected override _errorCode = HTTP_STATUS_CODE.SERVICE_UNAVAILABLE;
}
