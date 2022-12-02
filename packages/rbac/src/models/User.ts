import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Relation, Uuid, DateTime as DT, OneToManyRelationList, IRelationDescriptor } from '@spinajs/orm';
import { AccessControl } from 'accesscontrol';
import { DI, IContainer } from '@spinajs/di';
import { UserMetadata } from './UserMetadata';
import { UserAction } from './UserTimeline';

class UserMetadataRelation extends OneToManyRelationList<UserMetadata> {
  public async metadataExists(key: string) {
    return this.find((x) => x.Key === key) !== undefined;
  }

  [index: string]: any;
}

function UserMetadataRelationFactory(model: ModelBase<User>, desc: IRelationDescriptor, container: IContainer) {
  const repository = container.resolve(UserMetadataRelation, [model, desc.TargetModel, desc, []]);
  const proxy = {
    get(target: UserMetadataRelation, prop: string) {
      // if we try to call method or prop that exists return itF
      if ((target as any)[prop]) {
        return (target as any)[prop];
      } else {
        // check for metadata entries
        const found = target.find((x) => x.Key === prop);

        if (found) {
          return found.Value;
        }

        return undefined;
      }
    },
  };

  return new Proxy(repository, proxy);
}
/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('users')
export class User extends ModelBase<User> {
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
  @HasMany(UserMetadata, {
    factory: UserMetadataRelationFactory,
  })
  public Metadata: UserMetadataRelation;

  @HasMany(UserAction)
  public Actions: Relation<UserAction>;

  public can(resource: string, permission: string) {
    const ac = DI.get<AccessControl>('AccessControl');
    return (ac.can(this.Role) as any)[permission](resource);
  }
}
