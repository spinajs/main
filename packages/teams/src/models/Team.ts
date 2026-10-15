import { AccessResource, Parent } from '@spinajs/authz-orm';
import { Connection, CreatedAt, DatetimeValueConverter, Model, ModelBase, Primary, UpdatedAt, extractDecoratorPropertyDescriptor } from '@spinajs/orm';
import { DateTime } from 'luxon';

// @DateTime() refuses a `DateTime | null` property: the union's design type is Object.
const NullableDateTime = (): PropertyDecorator =>
  extractDecoratorPropertyDescriptor((model, _target, key) => {
    model.Converters.set(key, { Class: DatetimeValueConverter });
  });

@Connection('default')
@Model('teams')
@AccessResource('team')
export class Team extends ModelBase<Team> {
  @Primary()
  public id: string;

  @Parent('team', { nullable: true })
  public parent_id: string | null;

  public slug: string;

  public name: string;

  public description: string | null;

  @NullableDateTime()
  public archived_at: DateTime | null;

  // Kept by the service, not @SoftDelete: purge must still select deleted rows.
  @NullableDateTime()
  public deleted_at: DateTime | null;

  public created_by: string | null;

  @CreatedAt()
  public created_at: DateTime;

  @UpdatedAt()
  public updated_at: DateTime;
}
