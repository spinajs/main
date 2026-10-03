import { DI, Injectable, NewInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AUTHZ_DEFAULTS, AuthzDomains, DefaultAuthzDomains, authzStorage, compileFieldGlobs, filterObject, readDomainConfig, subtractFieldGlobs } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { BadRequest } from '@spinajs/exceptions';
import { ArgInputFilter, DataTransformer, RouteMiddleware } from '@spinajs/http';
import type { IController, IRoute, IRouteParameter, Request, Response } from '@spinajs/http';
import type * as express from 'express';

import { routeAccess, routeDomain } from './access/descriptor.js';
import type { AuthzHttpRouteMark } from './storage.js';

const PRIMITIVES = new Set(['String', 'Number', 'BigInt', 'Boolean']);

/** Route args that carry what the caller writes; query, url, header and cookie args are not writes. */
export const BODY_ARGS: ReadonlySet<string> = new Set(['FromBody', 'BodyFieldRouteArgs', 'FromForm', 'FromFormField', 'FromCSV', 'FromJSONFile', 'FromXmlRouteArgs', 'AsDbModel']);

export interface DecisionFields {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly writeMode: 'strip' | 'reject';
}

/**
 * The decision's field sets without the domain's `fields.neverRead`, and the domain's write mode
 * (design §11.3, B17). Without a decision (a route another policy group admitted) only
 * `neverRead` applies, in the route's domain.
 */
export function decisionFields(decision: Decision | undefined, domain: string = decision?.domain ?? 'root'): DecisionFields {
  const domains = DI.get(AuthzDomains);
  const configuration = DI.get(Configuration);
  let neverRead: readonly string[] = AUTHZ_DEFAULTS.fields.neverRead;
  let writeMode: 'strip' | 'reject' = AUTHZ_DEFAULTS.fields.write.mode;
  if (domains instanceof DefaultAuthzDomains) {
    const cfg = readDomainConfig((path) => configuration?.get(path), domains.lineage(domain));
    neverRead = cfg.fields.neverRead;
    writeMode = cfg.fields.writeMode;
  }
  const without = (globs: readonly string[]) => (neverRead.length === 0 ? globs : subtractFieldGlobs(globs, neverRead));
  return { read: without(decision?.fields.read ?? ['*']), write: without(decision?.fields.write ?? ['*']), writeMode };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/** Dotted leaf paths present in `before` (JSON-shaped) and missing from `after`; array elements share their array's path. */
function removedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  const out: string[] = [];
  for (const key of Object.keys(before as object)) {
    const value = (before as Record<string, unknown>)[key];
    const path = Array.isArray(before) ? prefix : prefix === '' ? key : `${prefix}.${key}`;
    const kept = isObject(after) && Object.hasOwn(after, key) ? after[key] : undefined;
    if (isObject(value) && Object.keys(value).length > 0) out.push(...removedPaths(value, kept, path));
    else if (kept === undefined) out.push(path);
  }
  return [...new Set(out)];
}

function notWritable(fields: readonly string[]): BadRequest {
  return Object.assign(new BadRequest(`fields not writable: ${fields.join(', ')}`), { error: 'fields_not_writable', fields });
}

/**
 * Strips, or in `reject` mode refuses with 400, the body input the route's decision does not let
 * the caller write (`decision.fields.write` minus `fields.neverRead`, design §11.3, B17). A named
 * primitive body field is checked by its name. A route another policy group admitted (no decision)
 * still loses `neverRead`; a route without `@Access`, or with `@UnfilteredInput`, is not filtered.
 */
@Injectable(ArgInputFilter)
export class AuthzInputFieldFilter extends ArgInputFilter {
  public filter(input: unknown, parameter: IRouteParameter): unknown {
    if (!BODY_ARGS.has(String(parameter.Type))) return input;
    const store = authzStorage().getStore();
    const mark = store?.AuthzHttpRoute as AuthzHttpRouteMark | undefined;
    const decision = store?.AuthzDecision;
    // Untouched: a route without @Access (login and password routes carry passwords), or one that opted out.
    if ((!mark && !decision) || mark?.unfilteredInput !== undefined) return input;

    const { write, writeMode } = decisionFields(decision, decision?.domain ?? mark?.domain);

    // Primitives and lists of primitives are a field of the record: checked by the parameter name. Objects and lists of objects are records.
    const field = !isObject(input) || PRIMITIVES.has((parameter.RuntimeType as { name?: string } | undefined)?.name ?? '') || (Array.isArray(input) && input.every((v) => !isObject(v)));
    if (field) {
      if (compileFieldGlobs(write).allows(parameter.Name)) return input;
      if (writeMode === 'reject') throw notWritable([parameter.Name]);
      return undefined;
    }

    const filtered = filterObject(write, input);
    const removed = removedPaths(JSON.parse(JSON.stringify(input)), filtered);
    if (removed.length === 0) return input;
    if (writeMode === 'reject') throw notWritable(removed);
    return filtered;
  }
}

function readable(data: unknown, decision: Decision | undefined, domain: string | undefined): unknown {
  if ((!decision && domain === undefined) || !isObject(data)) return data;
  return filterObject(decisionFields(decision, decision?.domain ?? domain).read, data);
}

/** `x-data-transform: authz-fields`: the response data limited to what the route's decision lets the caller read. */
@Injectable(DataTransformer)
export class AuthzFieldTransformer extends DataTransformer {
  public get Type(): string {
    return 'authz-fields';
  }

  public transform(data: unknown, request: express.Request): unknown {
    const storage = (request as Request).storage;
    return readable(data, storage?.AuthzDecision, (storage?.AuthzHttpRoute as AuthzHttpRouteMark | undefined)?.domain);
  }
}

/** Added by `@Access(…, { fields: 'filter' })`: the response data limited to `decision.fields.read` (B17). */
@NewInstance()
export class AuthzFieldsMiddleware extends RouteMiddleware {
  public isEnabled(route: IRoute, controller: IController): boolean {
    const access = routeAccess(controller, route.Method);
    return (access.route ?? access.controller)?.options.fields === 'filter';
  }

  public async onBefore(): Promise<void> {}

  // http calls this without awaiting it, so the data is replaced before the first await.
  public async onResponse(response: Response, route: IRoute, controller: IController): Promise<void> {
    const decision = authzStorage().getStore()?.AuthzDecision;
    const domain = routeDomain(routeAccess(controller, route.Method));
    const holder = response as unknown as { responseData?: unknown };
    const data = holder.responseData;
    holder.responseData = Promise.all(Array.isArray(data) ? data : [data]).then((resolved) => readable(Array.isArray(data) ? resolved : resolved[0], decision, domain));
  }

  public async onAfter(): Promise<void> {}
}
