import { Autoinject, Bootstrapper, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { JwsSigner } from '@spinajs/authn/contracts';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { isPlainObject } from '@spinajs/util';

import '../register-schema.js';
import { LocalJwsSigner } from './signer.js';
import type { PrivateJwk } from './signer.js';

/** `authn.keys.signer`. */
export interface SignerConfig {
  readonly current: string;
  /** Secret references the configuration resolves to private JWKs as JSON text. */
  readonly keys: readonly string[];
}

// The error names the position only: the text is a private key.
function privateJwkOf(secret: string, index: number): PrivateJwk {
  let jwk: unknown;
  try {
    jwk = JSON.parse(secret);
  } catch {
    jwk = undefined;
  }
  if (!isPlainObject(jwk)) {
    throw new InvalidOption(`authn.keys.signer.keys.${index} does not resolve to a private JWK as a JSON object`);
  }
  return jwk as unknown as PrivateJwk;
}

/** Registers a JwsSigner built from `authn.keys.signer` in `container`; null, and nothing registered, when it is null. */
export async function registerJwsSigner(container: IContainer): Promise<LocalJwsSigner | null> {
  const configuration = await container.resolve(Configuration);
  const config = configuration.get<SignerConfig | null>('authn.keys.signer', null);
  if (!config) {
    return null;
  }

  let signer: LocalJwsSigner;
  try {
    signer = new LocalJwsSigner(config.keys.map(privateJwkOf), { current: config.current });
  } catch (e) {
    throw e instanceof InvalidArgument ? new InvalidOption(`authn.keys.signer: ${e.message}`) : e;
  }
  container.register({ ConfiguredJwsSigner: () => signer }.ConfiguredJwsSigner).as(JwsSigner);
  return signer;
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
