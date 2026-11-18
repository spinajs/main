import { vi } from 'vitest';

const STATUS = Symbol('status');

export interface StatusReply {
  [STATUS]: number;
  body: unknown;
}

export const withStatus = (status: number, body: unknown = { message: `HTTP ${status}` }): StatusReply => ({ [STATUS]: status, body });

export interface FakeRequest {
  method: string;
  url: URL;
  body: unknown;
  /** 1 for the first request to this method and path. */
  call: number;
}

/** `'GET /_studio/api/traces'` → a JSON body, a `withStatus(...)` reply, or `(request) => body | reply`. */
export type FakeRoutes = Record<string, unknown>;

type FakeHandler = (request: FakeRequest) => unknown;

const isHandler = (route: unknown): route is FakeHandler => typeof route === 'function';
const isStatusReply = (reply: unknown): reply is StatusReply => typeof reply === 'object' && reply !== null && STATUS in reply;

const keyOf = (request: Pick<FakeRequest, 'method' | 'url'>) => `${request.method} ${request.url.pathname}`;

export function fakeApi(routes: FakeRoutes) {
  const log: FakeRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://studio.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const call = log.filter((entry) => keyOf(entry) === `${method} ${url.pathname}`).length + 1;
    const request: FakeRequest = { method, url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined, call };
    log.push(request);
    const route = routes[keyOf(request)];
    const reply = isHandler(route) ? await route(request) : route;
    if (reply === undefined) return respond(404, { message: `no fake route for ${keyOf(request)}` });
    if (isStatusReply(reply)) return respond(reply[STATUS], reply.body);
    return respond(200, reply);
  });
  vi.stubGlobal('fetch', fetch);
  const requests = (key: string) => log.filter((entry) => keyOf(entry) === key);
  return {
    fetch,
    requests,
    last(key: string): FakeRequest {
      const request = requests(key).at(-1);
      if (!request) throw new Error(`${key} was not requested`);
      return request;
    },
  };
}

const respond = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
