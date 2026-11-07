import type { Diagnostic } from '@spinajs/manifest';
import { configAt, diagnostic, type DoctorRule } from '../rule.js';

const KEY = 'http.routes.middlewares';
const SUFFIX = /middleware$/;

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// `Accepts` for `AcceptsMiddleware` is a likely slip, so the suffix is ignored on both sides.
function closest(name: string, known: string[]): string | undefined {
  const forms = (n: string) => [n.toLowerCase(), n.toLowerCase().replace(SUFFIX, '')];
  const limit = Math.max(1, Math.floor(name.length / 3));
  let best: { name: string; score: number } | undefined;
  for (const candidate of known) {
    const score = Math.min(...forms(name).flatMap((a) => forms(candidate).map((b) => distance(a, b))));
    if (score <= limit && (!best || score < best.score)) best = { name: candidate, score };
  }
  return best?.name;
}

function entryName(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    const service = (entry as { service?: unknown }).service;
    if (typeof service === 'string') return service;
  }
  return undefined;
}

export const unknownRouteMiddleware: DoctorRule = {
  code: 'CFG004',
  describe: 'Every name in http.routes.middlewares is a registered RouteMiddleware',
  run(manifest, ctx) {
    const entries = configAt(ctx.config, KEY);
    if (!Array.isArray(entries)) return [];
    const known = [...new Set(manifest.services.filter((s) => s.registeredAs.includes('RouteMiddleware')).map((s) => s.className))].sort();
    const out: Diagnostic[] = [];
    entries.forEach((entry, i) => {
      const name = entryName(entry);
      if (name === undefined || known.includes(name)) return;
      const suggestion = closest(name, known);
      const hint = suggestion ? `: did you mean '${suggestion}'?` : `. Registered: ${known.join(', ') || 'none'}`;
      out.push(diagnostic('CFG004', 'error', `${KEY}[${i}] names '${name}', which no RouteMiddleware registers${hint}`));
    });
    return out;
  },
};
