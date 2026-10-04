import type { OidcHttpClient } from '../http/client.js';
import { isPlainObject } from '../support.js';

/** OIDC Core §5.3 over a Bearer access token; JSON answers only (a signed or encrypted userinfo is refused). */
export async function fetchUserinfo(http: OidcHttpClient, endpoint: string, accessToken: string): Promise<Readonly<Record<string, unknown>>> {
  // GitHub's API refuses requests without a User-Agent.
  const { status, json } = await http.getJson(endpoint, { authorization: `Bearer ${accessToken}`, 'user-agent': 'spinajs-authn-oidc' });
  if (status !== 200 || !isPlainObject(json)) {
    throw new Error(`authn-oidc: the userinfo endpoint answered HTTP ${status} without a JSON object`);
  }
  return Object.freeze({ ...json });
}
