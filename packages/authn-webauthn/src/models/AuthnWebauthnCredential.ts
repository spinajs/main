import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** A registered WebAuthn credential; keyed by the SHA-256 of its id, which may be longer than an index allows. */
@Connection('default')
@Model('authn_webauthn_credential')
export class AuthnWebauthnCredential extends ModelBase<AuthnWebauthnCredential> {
  /** Hex SHA-256 of `credential_id`. */
  @Primary({ generated: 'assigned' })
  public id_hash: string;

  /** base64url. */
  public credential_id: string;

  public identity: string;

  /** COSE key, base64url. */
  public public_key: string;

  /** Postgres returns bigint as a string. */
  public counter: number | string;

  /** JSON array, or null. */
  public transports?: string | null;

  public aaguid?: string | null;

  public name?: string | null;

  @DT()
  public created_at: DateTime;

  // Optional rather than `| null`: @DT() rejects the union, whose design type is Object.
  @DT()
  public last_used_at?: DateTime;
}
