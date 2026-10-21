import { RouteArgs } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, IRoute } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

/**
 * Takes the `sensitive` fields of the option off `req.body`, and the raw bytes with them, once the argument holds its
 * copy (or failed): a later reader of the request, a log or another route arg, never gets them.
 */
function sensitiveOf(param: IRouteParameter): readonly unknown[] {
  const sensitive = (param.Options as { sensitive?: unknown } | undefined)?.sensitive;
  return Array.isArray(sensitive) ? sensitive : [];
}

const hasSensitive = (param: IRouteParameter): boolean => sensitiveOf(param).length > 0;

function dropSensitive(req: express.Request, param: IRouteParameter): void {
  const sensitive = sensitiveOf(param);
  if (sensitive.length === 0 || req.body === null || typeof req.body !== 'object') {
    return;
  }

  const body = req.body as Record<string, unknown>;
  for (const field of sensitive) {
    if (typeof field === 'string') {
      delete body[field];
    }
  }

  delete (req as { rawBody?: unknown }).rawBody;
}

@Injectable()
export class FromBody extends RouteArgs {
  public get SupportedType(): ParameterType {
    return ParameterType.FromBody;
  }

  public async extract(callData: IRouteCall,_args : unknown [],  param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    if (!req.body) {
      // `tryHydrateParam` is what refuses an absent `{ required: true }` parameter
      return { CallData: callData, Args: (param.Options as { required?: unknown } | undefined)?.required === true ? await this.tryHydrateParam(undefined, param, route) : null };
    }

    // Use presence, not truthiness — a body field legitimately holding 0,
    // false or '' must map to that value, not be treated as absent (which
    // would wrongly fall through to passing the whole body).
    const hasNamedField = Object.prototype.hasOwnProperty.call(req.body, param.Name);
    const isSingleBodyParam = [...route.Parameters.values()].filter((p) => p.Type === ParameterType.FromBody).length === 1;
    const arg = hasNamedField ? (req.body as Record<string, unknown>)[param.Name] : isSingleBodyParam ? req.body : null;

    try {
      const result = await this.tryHydrateParam(arg, param, route);
      // An untyped argument is req.body itself; it keeps the fields the request loses.
      return { CallData: callData, Args: result === req.body && hasSensitive(param) ? { ...result } : result };
    } finally {
      dropSensitive(req, param);
    }
  }
}
