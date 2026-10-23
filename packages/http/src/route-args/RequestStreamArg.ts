import type { Readable } from 'node:stream';
import type * as express from 'express';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { RouteArgs } from './RouteArgs.js';
import { limitRequestStream } from './limit-request-stream.js';
import type { IRouteCall, IRouteParameter } from '../interfaces.js';
import { Parameter, Route } from '../decorators.js';
import { UnsupportedMediaTypeException } from '../exceptions.js';

export interface IRequestStreamOptions {
  /** The body may hold at most this many bytes; one more fails the stream with LimitExceeded, answered 413. */
  maxBytes?: number;
}

// A body parser that took the body leaves the stream ended, or flowing while it still reads.
function isBodyTaken(req: Readable): boolean {
  return req.readableEnded || req.readableFlowing !== null;
}

/** Route arg of `@RequestStream()`: the raw request body as a stream. */
@Injectable()
export class RequestStreamArg extends RouteArgs {
  public get SupportedType(): string {
    return 'RequestStreamArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: express.Request) {
    if (isBodyTaken(req)) {
      throw new UnsupportedMediaTypeException('this route reads a raw request body, send it as application/octet-stream');
    }

    const maxBytes = (param.Options as IRequestStreamOptions | null)?.maxBytes;
    return { CallData: callData, Args: maxBytes === undefined ? req : limitRequestStream(req, maxBytes) };
  }
}

/**
 * The raw request body as a `Readable`. Requests whose body a parser of `http.middlewares` already took (JSON,
 * urlencoded, XML text) are answered 415. Without `maxBytes` the action gets the request itself.
 */
export function RequestStream(options: IRequestStreamOptions = {}): ParameterDecorator {
  const { maxBytes } = options;
  if (maxBytes !== undefined && !(Number.isSafeInteger(maxBytes) && maxBytes >= 0)) {
    throw new InvalidArgument(`@RequestStream maxBytes must be a non-negative integer, got ${maxBytes}`, 'maxBytes');
  }
  return Route(Parameter('RequestStreamArg', null, { maxBytes }));
}
