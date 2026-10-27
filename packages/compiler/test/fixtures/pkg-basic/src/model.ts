import { ModelBase, Model, Connection, Primary, BelongsTo, HasMany, HasManyToMany, ForwardBelongsTo, Relation, SingleRelation } from '@spinajs/orm';
import { AccessResource } from '@spinajs/authz-orm';

@Model('tags') export class Tag extends ModelBase<Tag> { @Primary() public Id: number; public Name: string }
@Model('post_tags') export class PostTag extends ModelBase<PostTag> { @Primary() public Id: number }

@Model('posts')
@Connection('default')
@AccessResource('post')
export class Post extends ModelBase<Post> {
  @Primary() public Id: number;
  public Title: string;
  public Body?: string;
  public PublishedAt: Date | null;
  @BelongsTo('User') public Owner: SingleRelation<ModelBase>;
  @ForwardBelongsTo({ forwardRef: () => Tag }) public MainTag: SingleRelation<Tag>;
  @HasMany(Tag) public Tags: Relation<Tag, Post>;
  @HasManyToMany(PostTag, Tag) public AllTags: Relation<Tag, Post>;
}
