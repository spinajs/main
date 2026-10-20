import type { Policy } from '@spinajs/authz';

import { PolicyStore } from '../../contracts.js';

/** Policies held in memory: tests, and the write handlers' in-memory mode. Each write bumps the version. */
export class MemoryPolicyStore extends PolicyStore {
  readonly name: string = 'memory';
  private readonly policies = new Map<string, Policy>();
  private counter = 0;

  constructor(policies: readonly Policy[] = []) {
    super();
    for (const p of policies) this.policies.set(p.id, p);
  }

  async load(): Promise<readonly Policy[]> {
    return [...this.policies.values()];
  }

  async version(): Promise<string> {
    return String(this.counter);
  }

  put(policy: Policy): void {
    this.policies.set(policy.id, policy);
    this.counter++;
  }

  delete(id: string): boolean {
    const had = this.policies.delete(id);
    if (had) this.counter++;
    return had;
  }
}
