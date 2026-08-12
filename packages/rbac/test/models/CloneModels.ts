import { BelongsTo, Connection, IWhereBuilder, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { OrmResource, ResourceOwner } from '../../src/decorators.js';
import { User } from '../../src/models/User.js';

/**
 * Fixture for the "a clone must carry the same rbac constraint as the query it was cloned
 * from" rule.
 *
 * The constraint is deliberately expressed as a correlated `whereExist` rather than a plain
 * `where` on the owner column, because that is the shape real `readOwn` rules take when
 * ownership does not live on the row itself — and it is the shape that used to VANISH from a
 * clone, leaving an uncorrelated `EXISTS ( SELECT ... )` that is true for every row.
 *
 * Shares the `test` table with the other rbac fixtures but declares its own resource name, so
 * granting it cannot affect them.
 */
@Connection('default')
@Model('test')
@OrmResource('CloneRbac')
export class CloneRbacModel extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;

  @BelongsTo(User, 'UserId', 'Id')
  public Owner: SingleRelation<User>;

  public static rbac(this: IWhereBuilder<CloneRbacModel>, user: User) {
    this.whereExist('Owner', function (this: IWhereBuilder<User>) {
      this.where('Id', '=', user.Id);
    });
  }
}
