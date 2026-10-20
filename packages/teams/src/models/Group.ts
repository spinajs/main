import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Connection, CreatedAt, Model, ModelBase, Primary, UpdatedAt } from '@spinajs/orm';
import { DateTime } from 'luxon';

@Connection('default')
@Model('groups')
@AccessResource('group')
export class Group extends ModelBase<Group> {
  @Primary()
  public id: string;

  @Parent('team')
  public team_id: string;

  @Parent('group', { nullable: true })
  public parent_id: string | null;

  public slug: string;

  public name: string;

  public description: string | null;

  public created_by: string | null;

  @CreatedAt()
  public created_at: DateTime;

  @UpdatedAt()
  public updated_at: DateTime;
}
