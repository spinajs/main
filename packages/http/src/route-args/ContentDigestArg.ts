import type * as express from 'express';
import { Injectable } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';

import { RouteArgs } from './RouteArgs.js';
import type { IRouteCall, IRouteParameter } from '../interfaces.js';
import { Parameter, Route } from '../decorators.js';
import { parseContentDigest } from '../content-digest.js';

export interface IContentDigestOptions {
  /** Answer 400 when the request has no Content-Digest. */
  required?: boolean;
  /** Keep only these algorithms (case-insensitive); a header with none of them answers 400. */
  algorithms?: string[];
}

/** Route arg of `@ContentDigest()`: the request's RFC 9530 Content-Digest, keyed by lower-cased algorithm. */
@Injectable()
export class ContentDigestArg extends RouteArgs {
  public get SupportedType(): string {
    return 'ContentDigestArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: express.Request) {
    const { required = false, algorithms } = (param.Options ?? {}) as IContentDigestOptions;
    // Node lower-cases header names (FromHeaderArg relies on the same).
    const header = req.headers['content-digest'];
    const digests = parseContentDigest(Array.isArray(header) ? header.join(', ') : (header ?? ''));

    if (digests.size === 0) {
      if (required) throw new BadRequest('Content-Digest header is required');
      return { CallData: callData, Args: digests };
    }

    if (!algorithms) {
      return { CallData: callData, Args: digests };
    }

    const accepted = new Set(algorithms.map((algorithm) => algorithm.toLowerCase()));
    const kept = new Map([...digests].filter(([algorithm]) => accepted.has(algorithm)));
    if (kept.size === 0) {
      throw new BadRequest(`Content-Digest carries none of the accepted algorithms: ${[...accepted].join(', ')}`);
    }
    return { CallData: callData, Args: kept };
  }
}

/** The request's RFC 9530 Content-Digest as `Map<algorithm, digest bytes>`; an empty map when absent and not required. */
export function ContentDigest(options: IContentDigestOptions = {}): ParameterDecorator {
  return Route(Parameter('ContentDigestArg', null, options));
}
