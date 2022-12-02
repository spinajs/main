import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Relation, Uuid, DateTime as DT, OneToManyRelationList, IRelationDescriptor, InsertBehaviour } from '@spinajs/orm';
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
    set: (target: UserMetadataRelation, prop: string, value: any) => {
      // if we try to call method or prop that exists return it
      if ((target as any)[prop]) {
        return ((target as any)[prop] = value);
      } else {
        let meta = target.find((x) => x.Value === prop);

        if (meta) {
          meta.Value = value;

          return meta.update();
        } else {
          UserMetadata.where({
            User: model,
            Key: prop,
          })
            .first()
            .then((res) => {
              if (res) {
                res.Value = value;
                return res.update();
              }

              const nMeta = new UserMetadata({
                Key: prop,
                Value: value,
              });

              return target.add(nMeta);
            });
        }
      }

      return true;
    },
    get: (target: UserMetadataRelation, prop: string) => {
      // if we try to call method or prop that exists return it
      if ((target as any)[prop]) {
        return (target as any)[prop];
      } else {
        // check for metadata entries
        const found = target.find((x) => x.Key === prop);

        if (found) {
          return found.Value;
        }

        // if not found try to obtain it
        // or return null
        return UserMetadata.where({
          User: model,
          Key: prop,
        })
          .first()
          .then((res) => {
            // add to this repo for cache
            target.add(res);
            return res;
          });
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
