import { ISelectQueryBuilder } from './../../../orm/lib/interfaces.d';
import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Relation, Uuid, DateTime as DT, OneToManyRelationList, IRelationDescriptor, QueryScope, IWhereBuilder, InsertBehaviour } from '@spinajs/orm';
import { AccessControl } from 'accesscontrol';
import { DI, IContainer } from '@spinajs/di';
import { UserMetadata } from './UserMetadata';
import { UserAction } from './UserTimeline';

class UserMetadataRelation extends OneToManyRelationList<UserMetadata, User> {
  /**
   *
   * Checks if metadata exists, its DB first, it will only check DB for existence
   *
   * @param key - key to find
   * @returns {true|false}
   */
  public async exists(key: string | RegExp) {
    let result = null;
    if (key instanceof RegExp) {
      result = await UserMetadata.where({
        User: this.owner,
      }).andWhere('Key', 'rlike', key.source);
    } else {
      result = await UserMetadata.where({
        User: this.owner,
      }).andWhere('Key', key);
    }

    return result !== null && result !== undefined;
  }

  /**
   *
   * Deletes meta from DB
   *
   * @param key - meta key do delete or regexp
   */
  public async delete(key: string | RegExp) {
    if (key instanceof RegExp) {
      await UserMetadata.destroy()
        .where({
          User: this.owner,
        })
        .andWhere('Key', 'rlike', key.source);
    } else {
      await UserMetadata.destroy().where({
        Key: key,
        User: this.owner,
      });
    }

    // refresh meta
    await this.populate();
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
        const userMeta = new UserMetadata();
        userMeta.User.Value = model as User;
        userMeta.Key = prop;
        userMeta.Value = value;

        UserMetadata.insert(userMeta, InsertBehaviour.InsertOrUpdate);

        let meta = target.find((x) => x.Value === prop);

        if (meta) {
          meta.Value = value;
        } else {
          target.push(userMeta);
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

export class UserQueryScopes implements QueryScope {
  /**
   *
   * Fetch users that are not banned, are active & email confirmed, not deleted
   *
   */
  public isActiveUser(this: ISelectQueryBuilder<User>) {
    return this.where({
      IsBanned: false,
      IsActive: true,
      DeletedAt: null,
    });
  }
}

/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('users')
export class User extends ModelBase {
  protected _hidden: string[] = ['Password', 'Id'];

  public static readonly _queryScopes: UserQueryScopes = new UserQueryScopes();

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

  /**
   * Account is fully active (eg. passed registration)
   */
  public IsActive: boolean;

  /**
   * User additional information. Can be anything
   */
  @HasMany(UserMetadata, {
    factory: UserMetadataRelationFactory,
  })
  public Metadata: UserMetadataRelation;

  @HasMany(UserAction)
  public Actions: Relation<UserAction, User>;

  public can(resource: string, permission: string) {
    const ac = DI.get<AccessControl>('AccessControl');
    return (ac.can(this.Role) as any)[permission](resource);
  }
}
