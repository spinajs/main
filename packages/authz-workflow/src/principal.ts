import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { SYSTEM, UNATTENDED, engineLog } from '@spinajs/authz';
import type { AuthzLog, Principal } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/principal';

/**
 * Builds the principal a permissioned wait checks from the signal's stamp. An app that must reload the user
 * (attributes, deactivation) registers its own with `DI.register(X).as(SignalPrincipalFactory)`. Return `UNATTENDED`
 * for a signer that can no longer act; throw only for a failure worth asking again.
 */
export abstract class SignalPrincipalFactory {
  abstract principalOf(ref: PrincipalRef): Promise<Principal>;
}

@Injectable(SignalPrincipalFactory)
export class StampedSignalPrincipalFactory extends SignalPrincipalFactory {
  protected Log: AuthzLog = engineLog('authz-workflow');

  @Config('authz.workflow.stampedPrincipalWarning')
  protected WarningSwitch: boolean;

  private warned = false;

  /** `warn` decides the one-time warning without the config, for an instance built with `new`. */
  constructor(private readonly options: { readonly warn?: boolean } = {}) {
    super();
  }

  async principalOf(ref: PrincipalRef): Promise<Principal> {
    if (!this.warned) {
      this.warned = true;
      if (this.options.warn ?? this.WarningSwitch !== false) this.Log.warn('authz-workflow: signals are authorized from their principal stamp alone; register a SignalPrincipalFactory that reloads the user so deactivated users stop signalling');
    }
    if (ref.type === 'system') return SYSTEM;
    if (ref.type === 'unattended') return UNATTENDED;
    return Object.freeze({ type: ref.type, id: ref.id, authenticated: ref.type !== 'anonymous', source: 'workflow', attributes: Object.freeze({}) });
  }
}
