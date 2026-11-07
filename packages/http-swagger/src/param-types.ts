import type { IRouteParameter } from '@spinajs/http';

export type OpenApiParamDescription =
  | { in: 'header' | 'query' | 'path' | 'cookie'; name?: string; required?: boolean; description?: string; schema: object }
  | { in: 'body'; contentType: string; required?: boolean; description?: string; schema: object };

const PARAM_TYPES = new Map<string, (param: IRouteParameter) => OpenApiParamDescription | OpenApiParamDescription[]>();

/**
 * Documents a custom route-arg type, keyed by its `IRouteParameter.Type`. Consulted only for
 * types the builder has no mapping of its own for; a later registration of a type replaces the earlier one.
 */
export function registerOpenApiParamType(type: string, describe: (param: IRouteParameter) => OpenApiParamDescription | OpenApiParamDescription[]): void {
  PARAM_TYPES.set(type, describe);
}

/** undefined when the type is not registered; [] when it is registered and documents nothing. */
export function describeRegisteredParam(param: IRouteParameter): OpenApiParamDescription[] | undefined {
  const describe = PARAM_TYPES.get(param.Type);
  if (!describe) {
    return undefined;
  }

  const described = describe(param);
  return Array.isArray(described) ? described : [described];
}

// @spinajs/http's raw-body args. Registered here because http must not depend on http-swagger.
registerOpenApiParamType('RequestStreamArg', () => ({
  in: 'body',
  contentType: 'application/octet-stream',
  required: true,
  schema: { type: 'string', format: 'binary' },
}));

registerOpenApiParamType('ContentDigestArg', (param) => ({
  in: 'header',
  // The arg reads this header itself, so the argument's own name is never the wire name.
  name: 'content-digest',
  required: (param.Options as { required?: boolean } | null | undefined)?.required === true,
  description: 'RFC 9530 digest of the request body, e.g. `sha-256=:<base64>:`',
  schema: { type: 'string' },
}));

// @spinajs/orm-http's @KeysetQuery(). Registered here because orm-http must not depend on http-swagger.
registerOpenApiParamType('KeysetQueryRouteArg', () => [
  { in: 'query', name: 'limit', required: false, description: 'Rows per page; default 50, at most 500', schema: { type: 'integer', minimum: 1, maximum: 500 } },
  { in: 'query', name: 'after', required: false, description: 'The `next` cursor of the page before', schema: { type: 'string' } },
  { in: 'query', name: 'before', required: false, description: 'The `previous` cursor of the page after', schema: { type: 'string' } },
]);
