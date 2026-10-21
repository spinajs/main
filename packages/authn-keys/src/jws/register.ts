import { Autoinject, Bootstrapper, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import type { LocalJwsSigner } from './signer.js';

/** `authn.keys.signer`. */
export interface SignerConfig {
  readonly current: string;
  /** Secret references the configuration resolves to private JWKs as JSON text. */
  readonly keys: readonly string[];
}

/** Registers a JwsSigner built from `authn.keys.signer` in `container`; null, and nothing registered, when it is null. */
export async function registerJwsSigner(_container: IContainer): Promise<LocalJwsSigner | null> {
  throw new Error('not implemented: registerJwsSigner');
}

/** Registers the configured JwsSigner at boot, so the JWKS route and the verifiers' key lookup find it. */
@Injectable(Bootstrapper)
export class AuthnKeysSignerBootstrapper extends Bootstrapper {
  @Autoinject(Container)
  protected Container!: IContainer;

  public async bootstrap(): Promise<void> {
    await registerJwsSigner(this.Container);
  }
}
