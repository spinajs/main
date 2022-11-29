import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Relation, Uuid, DateTime as DT } from '@spinajs/orm';
import { AccessControl } from 'accesscontrol';
import { DI } from '@spinajs/di';
import { UserMetadata } from './UserMetadata';
import { UserAction } from './UserTimeline';

/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('users')
export class User extends ModelBase {
  protected _hidden: string[] = ['Password', 'Id'];

  @Primary()
  public Id: number;

  @Uuid()
  public Uuid: string;

  public Email: string;

  /**
   * Hashed password for user
   */
  public Password: string;

  /**
   * Displayed name ( for others to see )
   */
  public Login: string;

  /**
   * User role
   */
  public Role: string[];

  /**
   * User creation date
   */
  @CreatedAt()
  public CreatedAt: DateTime;

  /**
   * Registration date. User is registered when clicked confirmation link sended to provided email.
   */
  @DT()
  public RegisteredAt: DateTime;

  /**
   * User deletion date
   */
  @SoftDelete()
  public DeletedAt: DateTime;

  @DT()
  public LastLoginAt: DateTime;

  public IsBanned: boolean;

  public IsActive: boolean;

  /**
   * User additional information. Can be anything
   */
  @HasMany(UserMetadata)
  public Metadata: Relation<UserMetadata>;

  @HasMany(UserAction)
  public Actions: Relation<UserAction>;

  public can(resource: string, permission: string) {
    const ac = DI.get<AccessControl>('AccessControl');
    return (ac.can(this.Role) as any)[permission](resource);
  }
}
