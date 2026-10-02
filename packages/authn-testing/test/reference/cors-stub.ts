import type { HttpPort, HttpRequest, HttpResponse } from '../../src/harness/index.js';

export const CORS_STUB_ORIGIN = 'https://app.example.test';
export const CORS_STUB_PROBE = '/kit/probe';

/** Each flag is a deliberate defect for the mutation tests. */
export interface CorsStubMutants {
  readonly allowAnyWithCredentials?: boolean;
  readonly substringMatch?: boolean;
  readonly headersWhenEmpty?: boolean;
}

/**
 * Test-only CORS policy for the probe path (design §10.3): exact string match against the listed origins, `*` echoed
 * without credentials, no header at all for an empty or absent list.
 */
export function corsStub(origins: readonly string[] | null | undefined, mutants: CorsStubMutants = {}): HttpPort {
  const list = origins ?? [];
  const listed = (origin: string): boolean => (mutants.substringMatch ? list.some((l) => origin.startsWith(l)) : list.includes(origin));

  const send = async (req: HttpRequest): Promise<HttpResponse> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const origin = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'origin')?.[1];
    if (origin !== undefined) {
      if (list.includes('*')) {
        headers['access-control-allow-origin'] = mutants.allowAnyWithCredentials ? origin : '*';
        if (mutants.allowAnyWithCredentials) {
          headers['access-control-allow-credentials'] = 'true';
        }
      } else if (listed(origin) || (mutants.headersWhenEmpty && list.length === 0)) {
        headers['access-control-allow-origin'] = origin;
        headers['access-control-allow-credentials'] = 'true';
        headers['vary'] = 'Origin';
      }
      if (req.method === 'OPTIONS' && headers['access-control-allow-origin'] !== undefined) {
        headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE';
        headers['access-control-allow-headers'] = 'content-type';
      }
    }
    if (req.method === 'OPTIONS') {
      return { status: 204, headers, setCookie: [], body: undefined };
    }
    return { status: 200, headers, setCookie: [], body: { principal: null, clientIp: null, hits: 1 } };
  };
  return { send, origin: CORS_STUB_ORIGIN, sessionCookie: 'ssid', socketAddress: '127.0.0.1', probePath: CORS_STUB_PROBE, routes: {} };
}
