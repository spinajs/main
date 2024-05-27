import { ModelBase, Primary, Connection, Model, HasMany, Recursive, Relation } from '@spinajs/orm';


@Connection('sqlite')
@Model('category')
export class Category extends ModelBase<Category> {
  @Primary()
  public Id: number;

  public Name: string;

  @Recursive()
  @HasMany("Category", { foreignKey: 'parent_id' })
  public Children: Relation<Category, Category>;
}
