import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, BufferResponse, Get, Policy } from '@spinajs/http';
import type { IResponseHeader } from '@spinajs/http';
import { JwsSigner } from '@spinajs/authn/contracts';
import type { JwsKey } from '@spinajs/authn/contracts';

import { JwsSignerRegistered } from '../index.js';

const JWK_SET = 'application/jwk-set+json';

// A verifier caches the set, so it learns a rotated-in key within this time.
const CACHE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'public, max-age=300' });

// Built member by member: whatever a key object carries beyond these never reaches the wire.
function publicJwkOf(key: JwsKey): Record<string, string> {
  const { jwk } = key;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...('y' in jwk ? { y: jwk.y } : {}), kid: key.kid, alg: key.alg, use: 'sig' };
}

/**
 * The public keys of the JwsSigner as a JWK Set (RFC 7517), for the verifiers of the tokens it signs. Off (404) while
 * no JwsSigner is registered (`authn.keys.signer` is null). Needs no credentials and answers regardless of Accept.
 * @tags Keys
 */
@BasePath('/')
@Policy(JwsSignerRegistered)
export class AuthnJwksController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * JSON Web Key Set
   * `{ keys: [...] }`: every key the signer holds, so a key rotated in is published before it signs and a key
   * kept through the token lifetime still verifies. Public members only, cacheable for five minutes.
   */
  @Get('.well-known/jwks.json')
  public async jwks() {
    const signer = await this.Container.resolve(JwsSigner);
    const keys = (await signer.publicKeys()).map(publicJwkOf);
    return new BufferResponse(Buffer.from(JSON.stringify({ keys }), 'utf8'), JWK_SET, { Headers: [CACHE] });
  }
}
