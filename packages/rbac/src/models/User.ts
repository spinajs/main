import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Relation } from '@spinajs/orm';
import { UserMetadata } from './UserMetadata';
import { AccessControl } from 'accesscontrol';
import { DI } from '@spinajs/di';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('users')
export class User extends ModelBase {
  protected _hidden: string[] = ['Password'];

  @Primary()
  public Id: number;

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
  public RegisteredAt: DateTime;

  /**
   * User deletion date
   */
  @SoftDelete()
  public DeletedAt: DateTime;

  /**
   * User additional information. Can be anything
   */
  @HasMany(UserMetadata)
  public Metadata: Relation<UserMetadata>;

  public can(resource: string, permission: string) {
    const ac = DI.get<AccessControl>('AccessControl');
    return (ac.can(this.Role) as any)[permission](resource);
  }
}
