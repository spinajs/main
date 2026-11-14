import { BelongsTo, HasMany, Model, ModelBase, Primary, Relation, SingleRelation } from '@spinajs/orm';

@Model('companies')
export class Company extends ModelBase<Company> {
  @Primary() public Id: number;
  public Name: string;
}

@Model('users')
export class User extends ModelBase<User> {
  @Primary() public Id: number;
  public Name: string;
  @BelongsTo('Company') public Company: SingleRelation<Company>;
}

@Model('tags')
export class Tag extends ModelBase<Tag> {
  @Primary() public Id: number;
  public Name: string;
}

@Model('posts')
export class Post extends ModelBase<Post> {
  @Primary() public Id: number;
  public Title: string;
  public Published: boolean;
  @BelongsTo('User') public Owner: SingleRelation<User>;
  @HasMany(Tag) public Tags: Relation<Tag, Post>;
}
