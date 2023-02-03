import { ModelBase, Primary, Connection, Model, HasMany, Recursive, OneToManyRelationList } from '@spinajs/orm';

@Connection('sqlite')
@Model('category')
export class Category extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @Recursive()
  @HasMany(Category, { foreignKey: 'parent_id' })
  public Children: OneToManyRelationList<Category, Category>;
}
