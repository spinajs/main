import { Connection, DateTime as DT, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** A row of authn_key; OrmKeyStore maps it to the contract's KeyRecord. */
@Connection('default')
@Model('authn_key')
export class AuthnKey extends ModelBase<AuthnKey> {
  @Primary()
  public kid: string;

  public owner_type: string;

  public owner_id: string;

  public alg: string;

  /** The public JWK as JSON text, required members only. */
  public jwk: string;

  public thumbprint: string;

  /** The Ceiling as JSON text. */
  public scope?: string | null;

  public name?: string | null;

  @DT()
  public expires_at?: DateTime;

  @DT()
  public revoked_at?: DateTime;

  /** No column: whether the row holds an expires_at, on the rows OrmKeyStore reads. */
  public expires_at_set?: boolean;

  /** No column: whether the row holds a revoked_at, on the rows OrmKeyStore reads. */
  public revoked_at_set?: boolean;

  @DT()
  public last_used_at?: DateTime;

  /** PrincipalRef as `<type>:<id>`. */
  public created_by?: string | null;

  @DT()
  public created_at: DateTime;
}
