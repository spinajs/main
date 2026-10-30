import type { Diagnostic, RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';
import { routeMatchKey } from './route-key.js';

const segments = (r: RouteEntry): string[] => routeMatchKey(r.fullPath).split('/');

// Optional groups, wildcards and parameters inside a segment (`:id.json`) are left to Express; only whole-segment parameters are compared.
const comparable = (parts: string[]): boolean => parts.every((s) => s === ':' || !/[:*{}()]/.test(s));

/** Same length, and each segment of `earlier` equal to `later`'s or a parameter; `wider`: at least one parameter where `later` is literal. */
function covers(earlier: string[], later: string[]): { covers: boolean; wider: boolean } {
  if (earlier.length !== later.length || !comparable(earlier) || !comparable(later)) return { covers: false, wider: false };
  let wider = false;
  for (let i = 0; i < earlier.length; i++) {
    if (earlier[i] === later[i]) continue;
    if (earlier[i] !== ':') return { covers: false, wider: false };
    wider = true;
  }
  return { covers: true, wider };
}

// Express answers HEAD with a GET route that matches first, even on the same path.
function shadows(earlier: RouteEntry, later: RouteEntry): boolean {
  const { covers: all, wider } = covers(segments(earlier), segments(later));
  if (earlier.method === later.method) return wider;
  return all && earlier.method === 'get' && later.method === 'head';
}

export const shadowedRoute: DoctorRule = {
  code: 'HTTP004',
  describe: 'No route is shadowed by an earlier parameterised route of its controller',
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      c.routes.forEach((later, index) => {
        const earlier = c.routes.slice(0, index).find((r) => shadows(r, later));
        if (!earlier) return;
        const name = `${c.className}.${later.handler}`;
        out.push(
          diagnostic(
            'HTTP004',
            'warning',
            `${name} (${later.method.toUpperCase()} ${later.fullPath}) is never reached: ${c.className}.${earlier.handler} (${earlier.method === later.method ? '' : 'GET '}${earlier.fullPath}) is declared first and matches the same requests. Declare ${name} first.`,
            later.source,
          ),
        );
      });
    }
    return out;
  },
};
