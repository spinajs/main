import { Injectable } from '@spinajs/di';
import { CodedHttpException } from '@spinajs/exceptions';
import type { CodedErrorBody } from '@spinajs/exceptions';
import { HandleException } from '../decorators.js';
import { HTTP_STATUS_CODE, IResponseOptions, Response, ResponseFunction } from '../interfaces.js';
import { jsonResponse } from '../responses.js';

type CodedErrorFields = Partial<Pick<CodedHttpException, 'status' | 'code' | 'message' | 'details'>>;

const isErrorStatus = (status: unknown): status is number => Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599;

/**
 * Answers a `CodedHttpException` (and every subclass) with `{ code, message, details? }` and the exception's status.
 *
 * Always JSON, with no `Accept` negotiation and no error transformer, so the body is the same for every client; and no
 * stack, whatever `configuration.isProduction` says. Takes the exception itself or the error handler's copy of it.
 */
@HandleException(CodedHttpException)
@Injectable(Response)
export class CodedHttpExceptionResponse extends Response<CodedErrorFields> {
  protected _errorCode = HTTP_STATUS_CODE.INTERNAL_ERROR;
  protected _template = '';

  constructor(error: CodedErrorFields | Promise<CodedErrorFields> | null, protected options?: IResponseOptions) {
    super(error, options);
  }

  public async execute(): Promise<ResponseFunction> {
    const error = ((await this.prepareResponse()) ?? {}) as CodedErrorFields;
    const body: CodedErrorBody = {
      code: typeof error.code === 'string' ? error.code : 'internal',
      message: typeof error.message === 'string' ? error.message : '',
    };
    if (error.details !== undefined) {
      body.details = error.details;
    }

    return jsonResponse(body, { ...this.options, StatusCode: this.options?.StatusCode ?? (isErrorStatus(error.status) ? error.status : this._errorCode) });
  }
}
