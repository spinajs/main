import { DI, Injectable, NewInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzDomains, DefaultAuthzDomains, authzStorage, compileFieldGlobs, filterObject, readDomainConfig, subtractFieldGlobs } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';
import { BadRequest } from '@spinajs/exceptions';
import { ArgInputFilter, DataTransformer, RouteMiddleware } from '@spinajs/http';
import type { IController, IRoute, IRouteParameter, Request, Response } from '@spinajs/http';
import type * as express from 'express';

import { routeAccess } from './access/descriptor.js';
import './storage.js';

/** Route args that carry what the caller writes; query, url, header and cookie args are not writes. */
export const BODY_ARGS: ReadonlySet<string> = new Set(['FromBody', 'BodyFieldRouteArgs', 'FromForm', 'FromFormField', 'FromCSV', 'FromJSONFile', 'FromXmlRouteArgs', 'AsDbModel']);

export interface DecisionFields {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly writeMode: 'strip' | 'reject';
}

/** The decision's field sets without the domain's `fields.neverRead`, and the domain's write mode (design §11.3, B17). */
export function decisionFields(decision: Decision): DecisionFields {
  const domains = DI.get(AuthzDomains);
  const configuration = DI.get(Configuration);
  let neverRead: readonly string[] = [];
  let writeMode: 'strip' | 'reject' = 'strip';
  if (domains instanceof DefaultAuthzDomains) {
    const cfg = readDomainConfig((path) => configuration?.get(path), domains.lineage(decision.domain));
    neverRead = cfg.fields.neverRead;
    writeMode = cfg.fields.writeMode;
  }
  const without = (globs: readonly string[]) => (neverRead.length === 0 ? globs : subtractFieldGlobs(globs, neverRead));
  return { read: without(decision.fields.read), write: without(decision.fields.write), writeMode };
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
 * primitive body field is checked by its name. Without a decision (a route without `@Access`, or
 * one admitted by another policy group) the input passes as it is.
 */
@Injectable(ArgInputFilter)
export class AuthzInputFieldFilter extends ArgInputFilter {
  public filter(input: unknown, parameter: IRouteParameter): unknown {
    if (!BODY_ARGS.has(String(parameter.Type))) return input;
    const decision = authzStorage().getStore()?.AuthzDecision;
    if (!decision) return input;

    const { write, writeMode } = decisionFields(decision);

    if (!isObject(input)) {
      if (compileFieldGlobs(write).allows(parameter.Name)) return input;
      if (writeMode === 'reject') throw notWritable([parameter.Name]);
      return undefined;
    }

    const filtered = filterObject(write, input);
    if (writeMode === 'reject') {
      const removed = removedPaths(JSON.parse(JSON.stringify(input)), filtered);
      if (removed.length > 0) throw notWritable(removed);
    }
    return filtered;
  }
}

function readable(data: unknown, decision: Decision | undefined): unknown {
  if (!decision || !isObject(data)) return data;
  return filterObject(decisionFields(decision).read, data);
}

/** `x-data-transform: authz-fields`: the response data limited to what the route's decision lets the caller read. */
@Injectable(DataTransformer)
export class AuthzFieldTransformer extends DataTransformer {
  public get Type(): string {
    return 'authz-fields';
  }

  public transform(data: unknown, request: express.Request): unknown {
    return readable(data, (request as Request).storage?.AuthzDecision);
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
  public async onResponse(response: Response): Promise<void> {
    const decision = authzStorage().getStore()?.AuthzDecision;
    const holder = response as unknown as { responseData?: unknown };
    const data = holder.responseData;
    holder.responseData = Promise.all(Array.isArray(data) ? data : [data]).then((resolved) => readable(Array.isArray(data) ? resolved : resolved[0], decision));
  }

  public async onAfter(): Promise<void> {}
}
