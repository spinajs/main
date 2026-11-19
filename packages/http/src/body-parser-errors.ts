import express from 'express';
import { BadRequest, Exception } from '@spinajs/exceptions';

import { EntityTooLargeException, UnsupportedMediaTypeException } from './exceptions.js';

// The fields body-parser and http-errors set on the errors they raise.
interface IBodyParserError {
  type?: string;
  expose?: boolean;
  status?: number;
  message: string;
  body?: unknown;
}

/**
 * Error middleware that sits after the body parsers and rethrows their refusals as framework exceptions, which the
 * error map answers: a body over the limit as `EntityTooLargeException`, an unsupported charset or encoding as
 * `UnsupportedMediaTypeException`, anything else the client sent wrong as `BadRequest`.
 *
 * A parse failure's message quotes the body, and a body-parser error carries the raw text as `body`, so neither
 * is passed on. An exception thrown by a `verify` hook is passed on as it is.
 */
export function bodyParserErrors(): express.ErrorRequestHandler {
  return (err: IBodyParserError | undefined, _req, _res, next) => {
    if (err?.type === 'entity.verify.failed') {
      if (err instanceof Exception) {
        Reflect.deleteProperty(err, 'body');
        next(err);
      } else {
        next(new BadRequest('request body was refused'));
      }
    } else if (err?.type === 'entity.parse.failed') {
      next(new BadRequest('request body is not valid JSON'));
    } else if (err?.expose !== true) {
      next(err);
    } else if (err.status === 413) {
      next(new EntityTooLargeException('request body is too large'));
    } else if (err.status === 415) {
      next(new UnsupportedMediaTypeException(err.message));
    } else {
      next(new BadRequest(err.message));
    }
  };
}
