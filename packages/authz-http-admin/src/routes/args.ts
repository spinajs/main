import { AuthzAdminFailure } from '@spinajs/authz';
import { resolveAuthzDomain } from '@spinajs/authz-http';
import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { Parameter, Route, RouteArgs } from '@spinajs/http';
import type { IRoute, IRouteCall, IRouteParameter, Req, Request } from '@spinajs/http';
import { isPlainObject } from '@spinajs/util';
import type * as express from 'express';

import { BATCH_ENVELOPE_SCHEMA } from '../dto/batch.js';
import type { AuthzAdminCommandBatch } from '../dto/batch.js';
import { AuthzCommandSchemaRegistry } from '../schemas/registry.js';
import { inputFailure } from './answers.js';
import { decodeCommands } from './decode.js';

type Decorator = ReturnType<typeof Req>;
type Schema = { readonly properties?: Readonly<Record<string, { readonly type?: unknown }>> };

const q = (v: unknown): string => JSON.stringify(v);

/** A query string value as the type its schema property names: the query string itself has none, and the admin schemas are validated without coercion. */
function typedQuery(schema: Schema | undefined, query: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const type = schema?.properties?.[key]?.type;
    if (type === 'integer' && typeof value === 'string' && /^\d{1,15}$/.test(value)) out[key] = Number(value);
    else if (type === 'boolean' && (value === 'true' || value === 'false')) out[key] = value === 'true';
    else out[key] = value;
  }
  return out;
}

/** Route arg of `@AdminQuery()`: the whole query string as the parameter's DTO class, validated against its `@Schema`; a failure is 400 invalid_query. */
@Injectable()
export class AuthzAdminQueryArg extends RouteArgs {
  public get SupportedType(): string {
    return 'AuthzAdminQueryArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: express.Request) {
    const Dto = param.RuntimeType as new (data: unknown) => object;
    const schema = this.Validator.extractSchema(Dto) as Schema & object;
    const input = typedQuery(schema, req.query ?? {});
    const [valid, errors] = this.Validator.tryValidate(schema, input);
    if (!valid) throw inputFailure('invalid_query', errors);
    return { CallData: callData, Args: new Dto(input) };
  }
}

/** Route arg of `@AdminBody()`: the whole body as the parameter's DTO class. Unlike `@Body()`, a body key named as the parameter is not taken for the body. */
@Injectable()
export class AuthzAdminBodyArg extends RouteArgs {
  public get SupportedType(): string {
    return 'AuthzAdminBodyArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: express.Request, _res: express.Response, route: IRoute) {
    return { CallData: callData, Args: await this.tryHydrateParam(req.body ?? null, param, route) };
  }
}

/**
 * Route arg of `@AdminBatch()`: the body of POST /authz/commands. The envelope is checked against
 * BATCH_ENVELOPE_SCHEMA and each command against the schema AuthzCommandSchemaRegistry holds for its
 * kind, read on each request so that a late AuthzCommandSchemaSource counts; a kind no source
 * describes is refused. A failure is 400 invalid_request (not an object) or invalid_batch.
 */
@Injectable()
export class AuthzAdminBatchArg extends RouteArgs {
  @Autoinject(AuthzCommandSchemaRegistry)
  protected Registry: AuthzCommandSchemaRegistry;

  // Ajv caches every schema object it compiled for good, so the copies are keyed by content: sources may build fresh objects per call.
  private strictCopies = new Map<string, object>();

  public get SupportedType(): string {
    return 'AuthzAdminBatchArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request) {
    const body: unknown = req.body;
    if (!isPlainObject(body)) throw new AuthzAdminFailure('invalid_request', 'the body must be an object { commands, reason?, idempotencyKey?, dryRun? }');
    const [valid, errors] = this.Validator.tryValidate(BATCH_ENVELOPE_SCHEMA, body);
    if (!valid) throw inputFailure('invalid_batch', errors);

    const schemas = this.Registry.commands();
    const commands = body.commands as { kind: string }[];
    commands.forEach((command, i) => {
      if (!Object.hasOwn(schemas, command.kind)) throw new AuthzAdminFailure('invalid_batch', `command ${i} has kind ${q(command.kind)}, which no AuthzCommandSchemaSource describes`, `commands.${i}.kind`);
      const [ok, failures] = this.Validator.tryValidate(this.strict(command.kind, schemas[command.kind]), command);
      if (!ok) throw inputFailure('invalid_batch', failures, ['commands', String(i)]);
    });

    const options: Record<string, unknown> = {};
    for (const key of ['reason', 'idempotencyKey', 'dryRun'] as const) if (key in body) options[key] = body[key];
    const batch: AuthzAdminCommandBatch = { commands: decodeCommands(commands) as readonly unknown[], options };
    return { CallData: callData, Args: batch };
  }

  /** The command schema under an `authz.` id, which the validation package checks without coercion. */
  private strict(kind: string, schema: object): object {
    const key = `${kind}\n${JSON.stringify(schema)}`;
    let copy = this.strictCopies.get(key);
    if (!copy) this.strictCopies.set(key, (copy = { ...schema, $id: `authz.admin.command.${kind}` }));
    return copy;
  }
}

/** Route arg of `@AdminDomain()`: the authz domain of the request as the AuthzDomainResolver names it, `authz.http.admin.domain` being its fallback. */
@Injectable()
export class AuthzAdminDomainArg extends RouteArgs {
  // Before the inputs, so that an unknown domain is refused before the input is checked.
  public Priority = 10;

  @Config('authz.http.admin.domain')
  protected FallbackDomain: string;

  public get SupportedType(): string {
    return 'AuthzAdminDomainArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: express.Request) {
    return { CallData: callData, Args: await resolveAuthzDomain(req as Request, this.FallbackDomain) };
  }
}

/** The whole query string as the parameter's `@Schema` DTO class; 400 invalid_query when it breaks the schema. */
export function AdminQuery(): Decorator {
  return Route(Parameter('AuthzAdminQueryArg', null));
}

/** The whole body as the parameter's `@Schema` DTO class; 400 invalid_request when it breaks the schema. */
export function AdminBody(): Decorator {
  return Route(Parameter('AuthzAdminBodyArg', null, { required: true }));
}

/** The body of POST /authz/commands as AuthzAdminCommandBatch. */
export function AdminBatch(): Decorator {
  return Route(Parameter('AuthzAdminBatchArg', null));
}

/** The authz domain the admin routes run in for this request. */
export function AdminDomain(): Decorator {
  return Route(Parameter('AuthzAdminDomainArg', null));
}
