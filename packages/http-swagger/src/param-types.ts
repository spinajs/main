import type { IRouteParameter } from '@spinajs/http';

export type OpenApiParamDescription =
  | {
      in: 'header' | 'query' | 'path' | 'cookie';
      name?: string;
      required?: boolean;
      description?: string;
      schema: object;
      /** The media type of a value sent as one encoded text, e.g. JSON in a query string; documents it under `content`. */
      contentType?: string;
    }
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

type ListDescriptor = {
  GroupableColumns?: Set<string>;
  AggregatableColumns?: Map<string, string[]>;
  IncludableRelations?: Set<string>;
};

// orm-http's list args. Registered here because http-swagger reads orm descriptors by symbol and depends on neither orm nor orm-http.
const listDescriptorOf = (param: IRouteParameter): ListDescriptor =>
  (typeof param.Options === 'function' ? (Reflect.getMetadata(Symbol.for('MODEL_DESCRIPTOR'), param.Options) as ListDescriptor | undefined) : undefined) ?? {};

// orm-http's aggregateSchemaFor() and limits (aggregate.ts), which the server validates with.
const MEASURE_NAME = '^[A-Za-z_][A-Za-z0-9_]{0,62}$';
const MAX_MEASURES = 16;
const MAX_GROUP_COLUMNS = 8;

registerOpenApiParamType('AggregateModelRouteArg', (param) => {
  const descriptor = listDescriptorOf(param);
  const groupable = [...(descriptor.GroupableColumns ?? [])];
  const aggregatable = [...(descriptor.AggregatableColumns ?? [])];
  const countable = [...new Set([...groupable, ...aggregatable.map(([column]) => column)])];

  const measured = aggregatable.map(([column, functions]) => ({
    type: 'object',
    additionalProperties: false,
    required: ['name', 'fn', 'column'],
    properties: { name: { type: 'string', pattern: MEASURE_NAME }, fn: { type: 'string', enum: functions }, column: { type: 'string', enum: [column] } },
  }));
  const counted = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'fn'],
    properties: {
      name: { type: 'string', pattern: MEASURE_NAME },
      fn: { type: 'string', enum: ['count'] },
      ...(countable.length > 0 ? { column: { type: 'string', enum: countable } } : {}),
    },
  };

  return {
    in: 'query',
    required: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['measures'],
      properties: {
        groupBy: { type: 'array', maxItems: MAX_GROUP_COLUMNS, uniqueItems: true, items: groupable.length > 0 ? { type: 'string', enum: groupable } : { not: {} } },
        measures: { type: 'array', minItems: 1, maxItems: MAX_MEASURES, items: { anyOf: [...measured, counted] } },
        order: {
          type: 'array',
          maxItems: MAX_GROUP_COLUMNS + MAX_MEASURES,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['column'],
            properties: { column: { type: 'string', maxLength: 128 }, order: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] } },
          },
        },
        limit: { type: 'integer', minimum: 1 },
      },
    },
  };
});

registerOpenApiParamType('IncludeModelRouteArg', (param) => {
  const includable = Array.isArray(param.Options) ? (param.Options as string[]) : [...(listDescriptorOf(param).IncludableRelations ?? [])];

  return {
    in: 'query',
    required: false,
    description: includable.length > 0 ? `Relations to load, comma separated: ${includable.join(', ')}` : 'No relation can be included',
    // Comma separated text on the wire; the enum documents the names one entry may take.
    schema: { type: 'array', items: includable.length > 0 ? { type: 'string', enum: includable } : { type: 'string' } },
  };
});
