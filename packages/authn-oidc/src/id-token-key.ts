import { sessionKey } from '@spinajs/authn/contracts';

import { isNonEmptyString } from './support.js';

/** The validated ID token of an OIDC login, kept in the session only for a provider with `logout.storeIdToken`. */
export const OIDC_ID_TOKEN_KEY = sessionKey('OidcIdToken', (raw: unknown): string | undefined => (isNonEmptyString(raw) ? raw : undefined));
