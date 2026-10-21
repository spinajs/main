import { isPlainObject } from '@spinajs/util';

/** A body DTO: the fields of a JSON object body, which its `@Schema` then checks; anything else gives no fields. */
export abstract class AuthnInput {
  constructor(data?: unknown) {
    if (isPlainObject(data)) Object.assign(this, data);
  }
}

/**
 * The password a FreshAuth route, the role switch or impersonation re-authenticates with. No maxLength:
 * reauthCredentials refuses a longer one as a failed re-authentication and audits it (`password_too_long`). An empty
 * one counts as none.
 */
export const inlinePasswordField = { type: 'string', description: 'the account password, when the session is not fresh' } as const;

/** No C0 or C1 control character and no DEL. */
export const NO_CONTROL_CHARACTERS = '^[^\\u0000-\\u001f\\u007f-\\u009f]*$';

/** A non-empty string of at most `maxLength` characters. */
export const bounded = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength }) as const;
