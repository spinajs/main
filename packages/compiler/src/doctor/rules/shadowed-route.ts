import type { Diagnostic, RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';
import { routeMatchKey } from './route-key.js';

const segments = (r: RouteEntry): string[] => routeMatchKey(r.fullPath).split('/');

// Optional groups, wildcards and parameters inside a segment (`:id.json`) are left to Express; only whole-segment parameters are compared.
const comparable = (parts: string[]): boolean => parts.every((s) => s === ':' || !/[:*{}()]/.test(s));

/** `earlier` takes every request `later` would get: same length, and each segment equal or a parameter, at least one of them a parameter where `later` is literal. */
function shadows(earlier: string[], later: string[]): boolean {
  if (earlier.length !== later.length || !comparable(earlier) || !comparable(later)) return false;
  let wider = false;
  for (let i = 0; i < earlier.length; i++) {
    if (earlier[i] === later[i]) continue;
    if (earlier[i] !== ':') return false;
    wider = true;
  }
  return wider;
}

export const shadowedRoute: DoctorRule = {
  code: 'HTTP004',
  describe: 'No route is shadowed by an earlier parameterised route of its controller',
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      c.routes.forEach((later, index) => {
        const earlier = c.routes.slice(0, index).find((r) => r.method === later.method && shadows(segments(r), segments(later)));
        if (!earlier) return;
        const name = `${c.className}.${later.handler}`;
        out.push(
          diagnostic(
            'HTTP004',
            'warning',
            `${name} (${later.method.toUpperCase()} ${later.fullPath}) is never reached: ${c.className}.${earlier.handler} (${earlier.fullPath}) is declared first and matches the same requests. Declare ${name} first.`,
            later.source,
          ),
        );
      });
    }
    return out;
  },
};
