import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { ValidationFailed } from '@spinajs/validation';
import _ from 'lodash';
import { strictHeaderReader } from '../headers.js';
import type { HeaderSource, StrictHeaderOptions } from '../headers.js';

const readers = new WeakMap<IRouteParameter, (req: HeaderSource) => string | undefined>();

function strictReaderOf(param: IRouteParameter, name: string, strict: StrictHeaderOptions): (req: HeaderSource) => string | undefined {
  let reader = readers.get(param);
  if (reader === undefined) {
    reader = strictHeaderReader(name, strict);
    readers.set(param, reader);
  }
  return reader;
}

/** Names the rules, never the value: it came from the client. */
function refusal(param: IRouteParameter, name: string, { maxLength, pattern }: StrictHeaderOptions): ValidationFailed {
  const rules = [maxLength < Number.MAX_SAFE_INTEGER ? `at most ${maxLength} characters` : '', pattern ? 'matching its pattern' : ''].filter((r) => r !== '');
  const message = `Header '${name}' must be sent once${rules.length > 0 ? `, ${rules.join(' and ')}` : ''}`;
  return new ValidationFailed(message, [{ propertyName: param.Name, message, keyword: 'header', params: { header: name }, schemaPath: '#/header', instancePath: param.Name }]);
}

@Injectable()
export class FromHeader extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromHeader;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    const options = param.Options as { key?: string; strict?: StrictHeaderOptions } | undefined;
    const name: string = options?.key ? options.key : param.Name;
    // Node lower-cases the names in req.headers, so `@Header('X-Signature')` must look up `x-signature`.
    const key = name.toLowerCase();
    let arg = req.headers[key];

    const strict = options?.strict;
    if (strict !== undefined && arg !== undefined) {
      arg = strictReaderOf(param, key, strict)(req);
      if (arg === undefined) throw refusal(param, key, strict);
    }
    return { CallData: callData, Args: await this.tryHydrateParam(arg, param, route) };
  }

}
