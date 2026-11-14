import { BelongsTo, Column, CreatedAt, HasMany, HasManyToMany, Index, Int64, Json, Model, ModelBase, Primary, Relation, SingleRelation, Uuid } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { Version } from './version.js';

@Model('tags')
export class Tag extends ModelBase<Tag> {
  @Primary() public Id: number;
  public Name: string;
}

@Model('post_tags')
export class PostTag extends ModelBase<PostTag> {
  @Primary() public Id: number;
}

@Model('authors', { columns: 'exhaustive' })
@Index(['Email'], { unique: true, name: 'authors_email_unique' })
@Index(['LastName', 'FirstName'])
export class Author extends ModelBase<Author> {
  @Primary() public Id: number;
  @Column({ family: 'text', length: 320, unique: true }) public Email: string;
  public FirstName: string;
  public LastName: string | null;
  public Active: boolean;
  public Score: bigint;
  @Int64() public Views: string;
  public BirthDate: Date;
  @CreatedAt() public CreatedAt: DateTime;
  @Json() public Settings: { theme: string };
  public Avatar: Uint8Array;
  public Kind: 'admin' | 'user';
  @Column({ family: 'decimal', precision: 10, scale: 2, default: 0 }) public Balance: number;
  @Column({ default: { raw: 'CURRENT_TIMESTAMP' } }) public SeenAt: Date;
  @Version() public Version: number;
  @HasMany('Post') public Posts: Relation<Post, Author>;
}

@Model('posts')
export class Post extends ModelBase<Post> {
  @Primary({ generated: 'uuid' }) @Uuid() public Id: string;
  @BelongsTo(Author) public Author: SingleRelation<Author>;
  @BelongsTo('Author', 'editor', 'Id') public Editor: SingleRelation<Author>;
  @HasManyToMany(PostTag, 'Tag', { junctionModelTargetPk: 'tag_ref' }) public Tags: Relation<Tag, Post>;
}
