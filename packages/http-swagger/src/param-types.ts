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
