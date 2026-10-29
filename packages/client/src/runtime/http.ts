import { ProblemError, type ProblemDetails } from './errors.js';
import { serializeQuery } from './query.js';

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  onProblem?: (p: ProblemDetails) => void;
}

export interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
  path: string;
  params: string[];
  query?: string[];
  body?: 'json' | 'multipart';
  files?: string[];
  void?: boolean;
}

export type ClientDefinition = Record<string, Record<string, RouteDefinition>>;

type Bag = Record<string, unknown>;

function buildUrl(baseUrl: string, route: RouteDefinition, params: Bag, query: Bag | undefined): string {
  let path = route.path;
  for (const name of route.params) {
    const value = params[name] as string | number | boolean | null | undefined;
    if (value === undefined || value === null) throw new TypeError(`Missing path parameter '${name}' for ${route.method.toUpperCase()} ${route.path}`);
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const qs = query ? serializeQuery(query) : '';
  return `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
}

function toForm(body: Bag): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value instanceof Blob) form.append(key, value);
    else if (value !== undefined) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return form;
}

// Positional arguments are [params?] [query?] [body?]; a slot exists only when the route declares it.
function splitArgs(route: RouteDefinition, args: unknown[]): { params: Bag; query?: Bag; body?: Bag } {
  let index = 0;
  const next = (): Bag | undefined => args[index++] as Bag | undefined;
  const params = route.params.length > 0 ? (next() ?? {}) : {};
  const query = route.query?.length ? (next() ?? {}) : undefined;
  const body = route.body ? next() : undefined;
  return { params, query, body };
}

async function toProblem(response: Response, contentType: string): Promise<ProblemDetails> {
  if (contentType.includes('json')) return (await response.json()) as ProblemDetails;
  return { type: 'about:blank', title: response.statusText || 'Error', status: response.status, detail: await response.text() };
}

function call(route: RouteDefinition, options: ClientOptions) {
  return async (...args: unknown[]): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const { params, query, body } = splitArgs(route, args);

    const headers: Record<string, string> = { accept: 'application/json, application/problem+json', ...(await options.headers?.()) };
    const init: RequestInit = { method: route.method.toUpperCase(), headers };
    if (route.body === 'json' && body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    } else if (route.body === 'multipart' && body) {
      init.body = toForm(body);
    }

    const response = await doFetch(buildUrl(options.baseUrl, route, params, query), init);
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
