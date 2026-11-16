import type { CompiledPolicy, PolicyService } from '@spinajs/authz-ir';

import { domainConfig } from '../host.js';
import { ormToIR } from '../ir.js';

/** The policy IR of `domain`: its models, the `@AccessResource` relations and its `authz.combine`. The single producer of policy hashes. */
export async function compileDomainPolicy(domain: string, service: PolicyService, options: { stored?: 'include' | 'opaque' } = {}): Promise<CompiledPolicy> {
  // Lazy: an app that never compiles its policy does not load the IR package.
  const { compilePolicy } = await import('@spinajs/authz-ir');
  // Registration order differs between the CLI's model discovery and the app; a conflict must resolve the same way in both.
  const extra = ormToIR().sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return compilePolicy(service, { combine: domainConfig(domain).combine, extra, stored: options.stored ?? 'opaque' });
}
