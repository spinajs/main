import { Constructor, Injectable, isConstructor } from '@spinajs/di';
import { IRoute, IRouteCall, IRouteParameter, ParameterType, RouteArgs } from '@spinajs/http';
import { ModelBase, extractModelDescriptor } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import express from 'express';
import { aggregateColumnsOf, aggregateSchemaFor } from './aggregate.js';
import { AggregateDTO } from './dto.js';
import { readInclude } from './include.js';
import { IAggregateColumns } from './interfaces.js';

function parseJson(value: unknown, name: string): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A malformed value is the client's error (400), not a 500 out of the extractor.
    throw new InvalidArgument(`Parameter '${name}' is invalid JSON`, name);
  }
}

/** The request's value of a list argument: the query string first, then the body. */
function requestValue(req: express.Request, name: string): unknown {
  return req.query[name] ?? (req.body as Record<string, unknown> | undefined)?.[name];
}

// The validator compiles a schema once per object identity, so each model or column list gets one schema object.
const AGGREGATE_SCHEMAS = new WeakMap<object, object>();

function aggregateSchemaOf(options: Constructor<ModelBase> | IAggregateColumns): object {
  let schema = AGGREGATE_SCHEMAS.get(options);
  if (!schema) {
    schema = aggregateSchemaFor(isConstructor(options) ? aggregateColumnsOf(extractModelDescriptor(options)) : options);
    AGGREGATE_SCHEMAS.set(options, schema);
  }
  return schema;
}

@Injectable()
export class AggregateModelRouteArg extends RouteArgs {
  async resolve(): Promise<void> {}

  public get SupportedType(): ParameterType | string {
    return 'AggregateModelRouteArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<Constructor<ModelBase> | IAggregateColumns>, req: express.Request, _res: express.Response, route: IRoute) {
    const raw = requestValue(req, param.Name);
    if (raw === undefined || raw === null || raw === '') {
      return { CallData: callData, Args: undefined };
    }

    if (!param.Options) {
      throw new Error(`@Aggregate argument '${param.Name}' names no model or column list`);
    }

    const typed = { ...param, Schema: aggregateSchemaOf(param.Options), RuntimeType: AggregateDTO };
    const result: unknown = await this.tryHydrateParam(parseJson(raw, param.Name), typed, route);
    return { CallData: callData, Args: result };
  }
}

@Injectable()
export class IncludeModelRouteArg extends RouteArgs {
  async resolve(): Promise<void> {}

  public get SupportedType(): ParameterType | string {
    return 'IncludeModelRouteArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<Constructor<ModelBase> | string[]>, req: express.Request) {
    const options = param.Options;
    const includable = Array.isArray(options) ? options : [...(extractModelDescriptor(options)?.IncludableRelations ?? [])];
    // `_include` is the alias @FromModel already reads.
    const raw = requestValue(req, param.Name) ?? req.query[`_${param.Name}`];

    return { CallData: callData, Args: readInclude(raw, includable) };
  }
}
