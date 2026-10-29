import { Injectable } from '@spinajs/di';
import { CodedHttpException } from '@spinajs/exceptions';
import { HandleException } from '../decorators.js';
import { HTTP_STATUS_CODE, IResponseOptions, Response, ResponseFunction } from '../interfaces.js';
import { jsonResponse } from '../responses.js';
import { isProblem, toProblem } from '../problem.js';
import type { ProblemDetails } from '../problem.js';

const isErrorStatus = (status: unknown): status is number => Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599;

/**
 * Answers a `CodedHttpException` (and every subclass) with a problem document: the exception's status, `code`,
 * `detail` (its message) and `details` when set.
 *
 * Always JSON, with no `Accept` negotiation and no error transformer, so the body is the same for every client; and no
 * stack, whatever `http.errors.includeStack` says. Takes the exception itself or the error handler's problem document.
 */
@HandleException(CodedHttpException)
@Injectable(Response)
export class CodedHttpExceptionResponse extends Response<ProblemDetails | CodedHttpException> {
  protected _errorCode = HTTP_STATUS_CODE.INTERNAL_ERROR;
  protected _template = '';

  constructor(error: ProblemDetails | CodedHttpException | Promise<ProblemDetails | CodedHttpException> | null, protected options?: IResponseOptions) {
    super(error, options);
  }

  public async execute(): Promise<ResponseFunction> {
    const error = await this.prepareResponse();
    const data = (error ?? {}) as ProblemDetails | CodedHttpException;

    let body: ProblemDetails;
    if (isProblem(data)) {
      body = data as ProblemDetails;
      delete body.stack;
    } else {
      const status = (data as CodedHttpException).status;
      body = toProblem(data as CodedHttpException, isErrorStatus(status) ? status : this._errorCode, { includeStack: false, includeFields: ['details'], isProduction: true });
    }

    const StatusCode = this.options?.StatusCode ?? (isErrorStatus(body.status) ? body.status : this._errorCode);
    body.status = StatusCode;

    return jsonResponse(body, { ...this.options, StatusCode });
  }
}
