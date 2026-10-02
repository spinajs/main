import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, Principal } from '@spinajs/authn/contracts';

export interface PrincipalOfCall {
  readonly id: IdentityRef;
  readonly facts: AuthnFacts;
  readonly extra: Parameters<PrincipalFactory['principalOf']>[2];
}

export class RecordingPrincipalFactory extends PrincipalFactory {
  readonly calls: PrincipalOfCall[] = [];
  private readonly derive: (id: IdentityRef) => Readonly<Record<string, unknown>>;

  constructor(opts: { derive?: (id: IdentityRef) => Readonly<Record<string, unknown>> } = {}) {
    super();
    this.derive = opts.derive ?? (() => ({}));
  }

  async principalOf(id: IdentityRef, facts: AuthnFacts, extra: PrincipalOfCall['extra']): Promise<Principal> {
    this.calls.push({ id, facts, extra });
    return {
      type: id.type,
      id: id.id,
      authenticated: true,
      source: facts.sessionHandle ? 'session' : 'token',
      attributes: { ...extra.attributes, ...this.derive(id) },
      authn: facts,
      ceiling: extra.ceiling,
      onBehalfOf: extra.onBehalfOf,
      delegation: extra.delegation,
    };
  }
}
