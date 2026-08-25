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
   * The profile (a role name) this token is pinned to; null/undefined = legacy
   * token, scoped by the union of its roles. Validated against
   * `AccessTokenRolePolicy.allowedProfiles` at creation and on every request.
   */
  public Profile?: string;

  /**
   * Absolute expiration. Null/absent = never expires.
   *
   * NOTE: declared optional rather than as a `DateTime | null` union - the
   * `@DateTime()` decorator reads `design:type`, and a union is emitted as
   * `Object`, which it rejects at decoration time. An optional property still
   * emits `design:type = DateTime` while keeping the absence in the type.
   */
  @DT()
  public ExpiresAt?: DateTime<true>;

  @CreatedAt()
  public CreatedAt!: DateTime<true>;

  /**
   * Last successful authentication with this token. Updated throttled.
   * Null/absent until the token is used for the first time - see the note on
   * `ExpiresAt` for why this is optional rather than a nullable union.
   */
  @DT()
  public LastUsedAt?: DateTime<true>;

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
