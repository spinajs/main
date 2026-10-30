import type { Diagnostic, Manifest } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

export function providersOf(manifest: Manifest): Set<string> {
  const out = new Set<string>();
  for (const s of manifest.services) for (const key of s.registeredAs) out.add(key);
  for (const v of manifest.values) out.add(v.token);
  return out;
}

// Satisfied without a registration: the container resolves itself, `Log` is a factory function the extractor does not
// see, the configuration is loaded before any service, and `AsyncLocalStorage` is a Node class the container constructs.
export const AMBIENT_TOKENS: ReadonlySet<string> = new Set(['Container', 'Log', 'Configuration', 'AsyncLocalStorage']);

export const unresolvedInjection: DoctorRule = {
  code: 'DI001',
  describe: 'Every injected token has a registration',
  run(manifest) {
    const providers = providersOf(manifest);
    const out: Diagnostic[] = [];
    for (const s of manifest.services) {
      s.ctorInjects.forEach((token, index) => {
        if (!AMBIENT_TOKENS.has(token) && !providers.has(token)) out.push(diagnostic('DI001', 'error', `${s.className} injects '${token}' (constructor argument ${index}) but nothing registers it`, s.source));
      });
      for (const p of s.propertyInjects) {
        if (p.optional || p.array || AMBIENT_TOKENS.has(p.token) || providers.has(p.token)) continue;
        out.push(diagnostic('DI001', 'error', `${s.className} injects '${p.token}' (property ${p.property}) but nothing registers it`, s.source));
      }
    }
    return out;
  },
};
