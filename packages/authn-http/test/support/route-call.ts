import { CONTROLLED_DESCRIPTOR_SYMBOL, ParameterType, Response } from '@spinajs/http';
import type { ErrorStage, IController, IControllerDescriptor, IOnErrorDescriptor, IRoute, Request } from '@spinajs/http';
import type { IContainer } from '@spinajs/di';
import { DataValidator, ValidationFailed } from '@spinajs/validation';

import { clientOf } from '../../src/v3/client.js';

let validator: DataValidator | undefined;

/** A DataValidator with the shipped options (authn.* schemas strict), outside any container. */
async function validatorOf(): Promise<DataValidator> {
  if (validator) return validator;
  const v = new DataValidator();
  const own = (name: string, value: unknown) => Object.defineProperty(v, name, { value, configurable: true, writable: true });
  own('Options', { allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: true, messages: false, strict: { idPrefixes: ['authn.', 'authz.'] } });
  own('Sources', [{ Load: async () => [] }]);
  own('Log', { info: () => undefined, warn: () => undefined, error: () => undefined, trace: () => undefined, debug: () => undefined });
  await v.resolve();
  validator = v;
  return v;
}

function routeOf(controller: IController, method: string): { route: IRoute; descriptor: IControllerDescriptor } {
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, Object.getPrototypeOf(controller)) as IControllerDescriptor;
  const route = descriptor.Routes.get(method);
  if (!route) throw new Error(`${controller.constructor.name} has no route ${method}`);
  return { route, descriptor };
}

/** The parameter names of a method, which @spinajs/http reads from its source when it builds the routes. */
function paramNames(fn: (...args: never[]) => unknown): string[] {
  const src = fn.toString();
  const list = src.slice(src.indexOf('(') + 1, src.indexOf(')'));
  return list.split(',').map((p) => p.trim().split(/[\s=]/)[0]).filter((p) => p !== '');
}

async function argOf(v: DataValidator, param: IRoute['Parameters'] extends Map<unknown, infer P> ? P : never, name: string, req: Request): Promise<unknown> {
  const options = (param.Options ?? {}) as { required?: boolean; key?: string };
  switch (String(param.Type)) {
    case String(ParameterType.FromBody): {
      if (req.body === undefined || req.body === null) {
        if (options.required) throw new ValidationFailed(`Parameter '${param.Name}' is required`, [{ instancePath: param.Name, schemaPath: '#/required', keyword: 'required', params: { missingParameter: param.Name } }]);
        return null;
      }
      const Dto = param.RuntimeType as new (data: unknown) => object;
      const dto = new Dto(req.body);
      try {
        v.validate(dto);
      } finally {
        for (const field of (param.Options as { sensitive?: string[] } | undefined)?.sensitive ?? []) delete (req.body as Record<string, unknown>)[field];
      }
      return dto;
    }
    case String(ParameterType.FromParams): {
      const value = (req.params as Record<string, string> | undefined)?.[name];
      if (param.Schema && value !== undefined) v.validate(param.Schema as object, value as unknown as object);
      return value;
    }
    case String(ParameterType.FromHeader): {
      const value = req.headers[(options.key ?? param.Name).toLowerCase()];
      if (param.Schema && value !== undefined) v.validate(param.Schema as object, value as unknown as object);
      return value;
    }
    case String(ParameterType.Req):
      return req;
    case 'AuthnClientContextArg':
      return clientOf(req);
    default:
      throw new Error(`route-call: no stand-in for a ${String(param.Type)} argument`);
  }
}

async function handled(err: unknown, stage: ErrorStage, handlers: readonly IOnErrorDescriptor[], ctx: { req: Request; route: IRoute; controller: IController; container: IContainer }): Promise<unknown> {
  let current = err;
  for (const d of handlers) {
    if (d.Stages && !d.Stages.includes(stage)) continue;
    if (!d.On.some((t) => current instanceof t)) continue;
    const result = await d.Handler(current as Error, { ...ctx, res: {} as never, stage });
    if (result instanceof Response) return result;
    if (result instanceof Error) current = result;
  }
  throw current;
}

/** `req` with these route params. */
export const withParams = (req: Request, params: Record<string, string>): Request => Object.assign(req, { params: { ...(req.params as object | undefined), ...params } });

/**
 * Calls `method` of `controller` as its route does: the arguments from `req` (a body DTO validated, strict for authn.*
 * schemas), then the action, an error of either going through the route's and the controller's `@OnError` handlers.
 * Policies and route middlewares do not run.
 */
export async function callRoute(controller: IController, method: string, req: Request, container?: IContainer): Promise<unknown> {
  const v = await validatorOf();
  const { route, descriptor } = routeOf(controller, method);
  const handlers = [...(route.ErrorHandlers ?? []), ...(descriptor.ErrorHandlers ?? [])];
  const ctx = { req, route, controller, container: container ?? (controller as unknown as { Container: IContainer }).Container };
  const params = [...route.Parameters.values()].sort((a, b) => a.Index - b.Index);
  let args: unknown[];
  try {
    args = [];
    const names = paramNames((controller as unknown as Record<string, (...a: never[]) => unknown>)[method]);
    for (const p of params) args[p.Index] = await argOf(v, p, names[p.Index], req);
  } catch (err) {
    return handled(err, 'arguments', handlers, ctx);
  }
  try {
    return await (controller as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...args);
  } catch (err) {
    return handled(err, 'action', handlers, ctx);
  }
}
