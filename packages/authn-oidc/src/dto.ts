import { Schema } from '@spinajs/validation';
import { bodyOf, fieldSchema, oidcSubjectField } from '@spinajs/authn';

/** Longest value any OIDC query parameter may carry. */
export const OIDC_QUERY_VALUE_MAX = 4096;
export const OIDC_RETURN_TO_MAX = 1024;
export const OIDC_LOGOUT_TOKEN_MAX = 16384;
/** Node's header limit is 16 KiB for all headers together, so no single header can pass this. */
export const OIDC_HEADER_MAX = 16384;

/** The `:provider` path segment; the names in `authn.oidc.providers` follow it. */
export const oidcProviderParam = fieldSchema('authn.oidc.field.provider', { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const);

/** For the request headers the flow reads: only the cap that keeps a flooded header out. */
export const oidcHeader = (maxLength = OIDC_HEADER_MAX): object => ({ type: 'string', maxLength });

const queryValue = { type: 'string', maxLength: OIDC_QUERY_VALUE_MAX } as const;

/** `GET /auth/oidc/:provider` and `/reauth`. Closed: an unknown key is refused. */
@Schema(bodyOf([], { returnTo: { type: 'string', maxLength: OIDC_RETURN_TO_MAX } }, 'authn.oidc.beginQuery'))
export class OidcBeginQuery {
  public returnTo?: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}

/**
 * `GET /auth/oidc/:provider/callback`. Open on purpose: an IdP appends parameters of its own (`session_state`, `scope`,
 * `authuser`...), and refusing the callback for them would break the login. Only the keys the flow reads are checked.
 */
@Schema({
  $id: 'authn.oidc.callbackQuery',
  type: 'object',
  additionalProperties: true,
  properties: { code: queryValue, state: queryValue, iss: queryValue, error: queryValue, bounce: queryValue },
})
export class OidcCallbackQueryDto {
  public code?: string;
  public state?: string;
  public iss?: string;
  public error?: string;
  public bounce?: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}

/** `DELETE /auth/oidc/:provider/link`. */
@Schema(bodyOf([], { subject: oidcSubjectField }, 'authn.oidc.unlinkQuery'))
export class OidcUnlinkQuery {
  public subject?: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}

/** The body of `POST /auth/oidc/:provider/backchannel-logout`. Open: the IdP's sender is not ours; only `logout_token` is read. */
@Schema({
  $id: 'authn.oidc.backchannelForm',
  type: 'object',
  additionalProperties: true,
  required: ['logout_token'],
  properties: { logout_token: { type: 'string', minLength: 1, maxLength: OIDC_LOGOUT_TOKEN_MAX } },
})
export class BackchannelForm {
  public logout_token: string;

  constructor(data: object) {
    Object.assign(this, data);
  }
}
