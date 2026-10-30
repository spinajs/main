import type { Diagnostic, Manifest, ServiceEntry } from '@spinajs/manifest';
import { isUnresolvedTokenKey } from '../../token-key.js';
import { diagnostic, type DoctorRule } from '../rule.js';

function asyncProviders(manifest: Manifest): Map<string, ServiceEntry> {
  const out = new Map<string, ServiceEntry>();
  for (const s of manifest.services) if (s.async) for (const key of s.registeredAs) if (key !== 'Configuration') out.set(key, s);
  return out;
}

export const asyncIntoSync: DoctorRule = {
  code: 'DI003',
  describe: 'Asynchronous services are only injected where their promise is awaited',
  run(manifest) {
    const providers = asyncProviders(manifest);
    const out: Diagnostic[] = [];
    for (const s of manifest.services) {
      // The container awaits async dependencies of property and constructor injection; the promise only leaks
      // when the dependent also resolves something synchronously by hand.
      if (!s.async && (s.imperativeResolves ?? []).some((r) => !r.awaited)) {
        for (const p of s.propertyInjects) {
          const provider = providers.get(p.token);
          if (!provider || isUnresolvedTokenKey(p.token)) continue;
          out.push(diagnostic('DI003', 'error', `${s.className} is synchronous but injects asynchronous ${provider.className} via property ${p.property}: resolve() returns a promise there`, s.source));
        }
      }
      for (const r of s.imperativeResolves ?? []) {
        if (r.awaited || isUnresolvedTokenKey(r.token) || !providers.has(r.token)) continue;
        out.push(diagnostic('DI003', 'warning', `${s.className}.${r.method} calls DI.resolve(${r.token}) on an asynchronous service without await: the result is a cached instance or a promise`, r.source));
      }
    }
    return out;
  },
};
