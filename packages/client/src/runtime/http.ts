import { ProblemError, type ProblemDetails } from './errors.js';
import { fillPath } from './path.js';
import { appendQuery } from './query.js';
import { appendPart, bindArgs, checkHeader, emptyParts, pathArgument, type ArgWire, type RequestParts } from './wire.js';

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Passed to fetch; in a browser, `include` sends the cookies the browser holds for the API origin. */
  credentials?: RequestCredentials;
  onProblem?: (p: ProblemDetails) => void;
}

export interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
  /**
   * `{name}` placeholders take one segment, `{*name}` an array of segments, `[...]` is an optional group left out
   * when a placeholder inside it has no value, and `\` escapes the next character.
   */
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
  for (const [key, value] of Object.entries(asBag(params))) if (value !== undefined && value !== null) parts.path[key] = pathArgument(value, 'value');
  const query = route.query?.length ? next() : undefined;
  for (const [key, value] of Object.entries(asBag(query))) appendQuery(parts.query, key, value);
  const body = route.body ? next() : undefined;
  if (route.body === 'multipart' && body) parts.form = new FormData();
  parts.body = body;
  return parts;
}

function buildUrl(baseUrl: string, route: RouteDefinition, parts: RequestParts): string {
  const path = fillPath(route.path, parts.path, `${route.method.toUpperCase()} ${route.path}`);
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

type Json = Record<string, unknown>;

function parseObject(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

const textMember = (body: Json, key: string): string | undefined => (typeof body[key] === 'string' ? body[key] : undefined);

/** Takes only the RFC 9457 members, and the `code` and `errors` extensions the server declares, from an error body. */
async function toProblem(response: Response, contentType: string): Promise<ProblemDetails> {
  const text = await response.text();
  const body = contentType.includes('json') ? parseObject(text) : undefined;
  const problem: ProblemDetails = { type: 'about:blank', title: response.statusText || 'Error', status: response.status };
  if (!body) return text ? { ...problem, detail: text } : problem;
  const status = body.status;
  if (typeof status === 'number' && Number.isInteger(status)) problem.status = status;
  for (const key of ['type', 'title'] as const) problem[key] = textMember(body, key) ?? problem[key];
  for (const key of ['detail', 'instance', 'code'] as const) {
    const value = textMember(body, key);
    if (value !== undefined) problem[key] = value;
  }
  if (body.errors !== undefined) problem.errors = body.errors;
  return problem;
}

async function requestHeaders(options: ClientOptions, parts: RequestParts): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept: 'application/json, application/problem+json' };
  for (const [name, value] of Object.entries((await options.headers?.()) ?? {})) {
    checkHeader(name, value);
    headers[name.toLowerCase()] = value;
  }
  Object.assign(headers, parts.headers);
  if (parts.cookies.length > 0) headers.cookie = [headers.cookie, ...parts.cookies].filter(Boolean).join('; ');
  return headers;
}

function call(route: RouteDefinition, options: ClientOptions) {
  return async (...args: unknown[]): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const parts = route.args ? bindArgs(route.args, args) : slotParts(route, args);

    const headers = await requestHeaders(options, parts);
    const init: RequestInit = { method: route.method.toUpperCase(), headers, ...(options.credentials ? { credentials: options.credentials } : {}) };
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
