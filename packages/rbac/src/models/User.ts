import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, SoftDelete, HasMany, Relation, Uuid, DateTime as DT, OneToManyRelationList, IRelationDescriptor, QueryScope, InsertBehaviour, ISelectQueryBuilder } from '@spinajs/orm';
import { AccessControl, Permission } from 'accesscontrol';
import { DI, IContainer } from '@spinajs/di';
import { UserMetadata } from './UserMetadata.js';
import { UserAction } from './UserTimeline.js';
import { v4 as uuidv4 } from 'uuid';

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
          User: this.owner as any, // TODO FIX THIS !!!!!!!!!!!
        })
        .andWhere('Key', 'rlike', key.source);
    } else {
      await UserMetadata.destroy().where({
        Key: key,
        User: this.owner as any,
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
            if (res) {
              // add to this repo for cache
              target.push(res);
            }
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
  public isActiveUser(this: ISelectQueryBuilder<User[]> & UserQueryScopes) {
    return this.where({
      IsActive: true,
      DeletedAt: null,
    });
  }

  public whereEmail(this: ISelectQueryBuilder<User[]> & UserQueryScopes, email: string) {
    return this.where({
      Email: email,
    });
  }

  public whereLogin(this: ISelectQueryBuilder<User[]> & UserQueryScopes, email: string) {
    return this.where({
      Email: email,
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

  public constructor(data?: Partial<User>) {
    super(data);

    if (this.Uuid === undefined) {
      this.Uuid = uuidv4();
    }
  }

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

  public IsBanned : boolean;

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

  public get IsGuest(): boolean {
    return this.Role.indexOf('guest') !== -1 || this.Role.length === 0;
  }

  public can(resource: string, permission: string): Permission {
    const ac = DI.get<AccessControl>('AccessControl');
    return (ac.can(this.Role) as any)[permission](resource);
  }

  /**
   * Shorthand for check if user can read any resource
   * @param resource
   * @returns
   */
  public canReadAny(resource: string) {
    return this.can(resource, 'readAny');
  }
  public canReadOwn(resource: string) {
    return this.can(resource, 'readOwn');
  }

  public canUpdateAny(resource: string) {
    return this.can(resource, 'updateAny');
  }

  public canUpdateOwn(resource: string) {
    return this.can(resource, 'updateOwn');
  }

  public canDeleteAny(resource: string) {
    return this.can(resource, 'deleteAny');
  }

  public canDeleteOwn(resource: string) {
    return this.can(resource, 'deleteOwn');
  }

  public canCreateAny(resource: string) {
    return this.can(resource, 'createAny');
  }

  public canCreateOwn(resource: string) {
    return this.can(resource, 'createOwn');
  }

  public static getByLogin(login: string) {
    return User.query().whereLogin(login).first();
  }

  public static getByEmail(email: string) {
    return User.query().whereEmail(email).first();
  }

  public static getByUuid(uuid: string) {
    return User.query().where({
      Uuid: uuid,
    }).first();
  }
}
