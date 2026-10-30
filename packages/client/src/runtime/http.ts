import { ProblemError, type ProblemDetails } from './errors.js';
import { appendQuery } from './query.js';
import { appendPart, bindArgs, emptyParts, wireText, type ArgWire, type RequestParts } from './wire.js';

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  onProblem?: (p: ProblemDetails) => void;
}

export interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
  /** `{name}` placeholders are filled from path arguments. */
  path: string;
  /** One entry per positional argument. When present, the `params` / `query` / `body` slots below are ignored. */
  args?: ArgWire[];
  params?: string[];
  query?: string[];
  body?: 'json' | 'multipart';
  files?: string[];
  void?: boolean;
}

export type ClientDefinition = Record<string, Record<string, RouteDefinition>>;

type Bag = Record<string, unknown>;

function asBag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

// Without `args`, positional arguments are [params?] [query?] [body?]; a slot exists only when the route declares it.
function slotParts(route: RouteDefinition, args: unknown[]): RequestParts {
  let index = 0;
  const next = (): unknown => args[index++];
  const parts = emptyParts();
  const params = route.params?.length ? next() : undefined;
  for (const [key, value] of Object.entries(asBag(params))) if (value !== undefined && value !== null) parts.path[key] = wireText(value, 'value');
  const query = route.query?.length ? next() : undefined;
  for (const [key, value] of Object.entries(asBag(query))) appendQuery(parts.query, key, value);
  const body = route.body ? next() : undefined;
  if (route.body === 'multipart' && body) parts.form = new FormData();
  parts.body = body;
  return parts;
}

function buildUrl(baseUrl: string, route: RouteDefinition, parts: RequestParts): string {
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = parts.path[name];
    if (value === undefined) throw new TypeError(`Missing path parameter '${name}' for ${route.method.toUpperCase()} ${route.path}`);
    return encodeURIComponent(value);
  });
  const qs = parts.query.join('&');
  return `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
}

function requestBody(parts: RequestParts, headers: Record<string, string>): BodyInit | undefined {
  const hasFields = Object.keys(parts.fields).length > 0;
  if (parts.form) {
    for (const [key, value] of Object.entries({ ...asBag(parts.body), ...parts.fields })) appendPart(parts.form, key, value);
    return parts.form;
  }
  if (parts.body instanceof Blob) return parts.body;
  if (parts.body === undefined && !hasFields) return undefined;
  headers['content-type'] = 'application/json';
  return JSON.stringify(hasFields ? { ...asBag(parts.body), ...parts.fields } : parts.body);
}

async function toProblem(response: Response, contentType: string): Promise<ProblemDetails> {
  if (contentType.includes('json')) return (await response.json()) as ProblemDetails;
  return { type: 'about:blank', title: response.statusText || 'Error', status: response.status, detail: await response.text() };
}

function call(route: RouteDefinition, options: ClientOptions) {
  return async (...args: unknown[]): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const parts = route.args ? bindArgs(route.args, args) : slotParts(route, args);

    const headers: Record<string, string> = { accept: 'application/json, application/problem+json', ...(await options.headers?.()), ...parts.headers };
    if (parts.cookies.length > 0) headers.cookie = [headers.cookie, ...parts.cookies].filter(Boolean).join('; ');
    const init: RequestInit = { method: route.method.toUpperCase(), headers };
    const body = requestBody(parts, headers);
    if (body !== undefined) init.body = body;

    const response = await doFetch(buildUrl(options.baseUrl, route, parts), init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const problem = await toProblem(response, contentType);
      options.onProblem?.(problem);
      throw new ProblemError(problem, response.status);
    }
    if (route.void || response.status === 204) return undefined;
    return contentType.includes('json') ? response.json() : response.text();
  };
}

export function createClient<T>(definition: ClientDefinition, options: ClientOptions): T {
  const client: Record<string, Record<string, unknown>> = {};
  for (const [controller, routes] of Object.entries(definition)) {
    client[controller] = {};
    for (const [name, route] of Object.entries(routes)) client[controller][name] = call(route, options);
  }
  return client as T;
}
