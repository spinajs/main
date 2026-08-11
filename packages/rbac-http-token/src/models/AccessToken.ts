import { BelongsTo, Connection, CreatedAt, DateTime as DT, Hidden, Model, ModelBase, Primary, Set, SingleRelation } from '@spinajs/orm';
import { User } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { _check_arg, _default } from '@spinajs/util';

/**
 * Personal access token. Only the SHA-256 hash of the token is stored;
 * the plaintext is returned once at creation and cannot be recovered.
 */
@Connection('default')
@Model('rbac_access_tokens')
export class AccessToken extends ModelBase<AccessToken> {
  public constructor(data?: Partial<AccessToken>) {
    super(data);
    this.Uuid = _check_arg(_default(uuidv4()))(this.Uuid, 'uuid');
  }

  /**
   * Internal row id, never leaves the process. Tokens are addressed by Uuid.
   */
  @Primary()
  @Hidden()
  public Id!: number;

  /**
   * Public identifier used by the API and CLI.
   */
  public Uuid!: string;

  /**
   * Human readable label ("ci deploy key").
   */
  public Name!: string;

  /**
   * SHA-256 hex digest of the plaintext token. Hidden: even the hash is
   * internal - leaking it invites offline correlation.
   */
  @Hidden()
  public Token!: string;

  /**
   * Roles allowed on this token. Effective roles at request time are the
   * intersection of this list with the owner's current roles.
   */
  @Set()
  public Roles!: string[];

  /**
   * Absolute expiration. Null = never expires.
   *
   * NOTE: declared as plain `DateTime` even though the column is nullable - the
   * `@DateTime()` decorator reads `design:type`, and a `DateTime | null` union
   * is emitted as `Object`, which it rejects at decoration time. Same convention
   * as `User.LastLoginAt` / `User.DeletedAt` in `@spinajs/rbac`.
   */
  @DT()
  public ExpiresAt!: DateTime;

  @CreatedAt()
  public CreatedAt!: DateTime;

  /**
   * Last successful authentication with this token. Updated throttled.
   * Null until the token is used for the first time - see the note on `ExpiresAt`
   * for why the null is not part of the declared type.
   */
  @DT()
  public LastUsedAt!: DateTime;

  @Hidden()
  @BelongsTo('User')
  public User!: SingleRelation<User>;

  @Hidden()
  public user_id!: number;

  /**
   * True when the token carries an expiration in the past.
   */
  public get IsExpired(): boolean {
    return !!this.ExpiresAt && this.ExpiresAt <= DateTime.now();
  }
}
