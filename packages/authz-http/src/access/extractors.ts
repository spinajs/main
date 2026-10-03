import { InvalidArgument } from '@spinajs/exceptions';
import type { Class } from '@spinajs/di';
import type { ResourceType } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import type { ModelBase } from '@spinajs/orm';

import type { ResourceExtractor } from '../api.js';

const EXTRACTOR = Symbol.for('authz:access:extractor');

/** What an extractor built here declares about itself, for boot checks and swagger. */
export interface ExtractorInfo {
  readonly type?: ResourceType;
  readonly from?: 'param' | 'body' | 'query' | 'model';
  readonly name?: string;
  /** `fromParam(…, { by })`: the field of the resource the value identifies. */
  readonly by?: string;
  readonly model?: Class<ModelBase>;
}

function described(info: ExtractorInfo, fn: ResourceExtractor): ResourceExtractor {
  Object.defineProperty(fn, EXTRACTOR, { value: Object.freeze(info) });
  return fn;
}

/** Marks the resource type a custom extractor yields, so boot checks and swagger can read it. */
export function typedExtractor(type: ResourceType, fn: ResourceExtractor): ResourceExtractor {
  return described({ type }, fn);
}

export function extractorInfo(extractor: ResourceExtractor | undefined): ExtractorInfo | undefined {
  return extractor ? (extractor as unknown as Record<symbol, ExtractorInfo | undefined>)[EXTRACTOR] : undefined;
}

/** The type an extractor declared; undefined for a custom one or `fromModel` (the adapter knows it). */
export function extractorType(extractor: ResourceExtractor | undefined): ResourceType | undefined {
  return extractorInfo(extractor)?.type;
}

function idOf(value: unknown, where: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  throw new InvalidArgument(`${where} is required to identify the resource`, where);
}

function readPath(source: unknown, path: string): unknown {
  let value = source;
  for (const key of path.split('.')) {
    value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}

/**
 * `{ type, id }` from a url parameter. `by` names the field of the resource the value identifies
 * (e.g. `Uuid` for users); refs carry that value as their id, so it is documentation for swagger.
 */
export function fromParam(param: string, type: ResourceType, opts?: { by?: string }): ResourceExtractor {
  return described({ type, from: 'param', name: param, ...(opts?.by !== undefined ? { by: opts.by } : {}) }, (req: Request) => ({ type, id: idOf(req.params?.[param], `url parameter ${param}`) }));
}

/** `{ type, id }` from a dotted path of the request body. */
export function fromBody(path: string, type: ResourceType): ResourceExtractor {
  return described({ type, from: 'body', name: path }, (req: Request) => ({ type, id: idOf(readPath(req.body, path), `body.${path}`) }));
}

/** `{ type, id }` from a query parameter. */
export function fromQuery(param: string, type: ResourceType): ResourceExtractor {
  return described({ type, from: 'query', name: param }, (req: Request) => ({ type, id: idOf(req.query?.[param], `query parameter ${param}`) }));
}

/**
 * An unloaded instance of `model` holding the url parameter as its primary key; the domain's ORM
 * adapter turns it into the ref its `@AccessResource` declares (design §11.2, §12.3).
 */
export function fromModel(model: Class<ModelBase>, param: string): ResourceExtractor {
  return described({ from: 'model', name: param, model }, (req: Request) => {
    const instance = new (model as unknown as new () => ModelBase)();
    instance.PrimaryKeyValue = idOf(req.params?.[param], `url parameter ${param}`);
    return instance;
  });
}
