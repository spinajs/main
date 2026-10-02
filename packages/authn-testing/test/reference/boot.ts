import type { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { HarnessContext } from '../../src/behaviour/index.js';
import type { BootPort } from '../../src/harness/index.js';
import { buildReference } from './harness.js';

/** BootPort over the reference service: listed strategies by instance or by a known service name; checkConfig is N1's. */
export function referenceBoot(ctx: HarnessContext, known: Readonly<Record<string, () => AuthenticationStrategy>> = {}): BootPort {
  return {
    async start(spec) {
      const registered = new Map<string, AuthenticationStrategy>();
      for (const s of spec.strategies ?? []) {
        if (s.instance) registered.set(s.service, s.instance);
      }
      const listed: AuthenticationStrategy[] = [];
      for (const s of (spec.strategies ?? []).filter((x) => x.listed)) {
        const strategy = registered.get(s.service) ?? known[s.service]?.();
        if (!strategy) {
          return { ok: false, error: new Error(`no strategy registered as ${s.service} (${s.name})`) };
        }
        listed.push(strategy);
      }
      try {
        const { service } = buildReference({ ...ctx, config: spec.config ?? {} }, { strategies: listed });
        return { ok: true, service, dispose: async () => undefined };
      } catch (error) {
        return { ok: false, error };
      }
    },
    async checkConfig() {
      throw new Error('checkConfig is not implemented by the reference: A24 first runs in N1');
    },
  };
}
