import { BelongsTo, Bool, Connection, DateTime as DateTimeColumn, HasMany, HasManyToMany, Json, Model, ModelBase, Primary, Relation, SingleRelation } from '@spinajs/orm';
import { DateTime } from 'luxon';

export const CONFORMANCE_CONNECTION = 'conformance';

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_tags')
export class CfTag extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_post_tags')
export class CfPostTag extends ModelBase {
  @Primary()
  public Id: number;

  public PostId: number;

  public TagId: number;
}

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_posts')
export class CfPost extends ModelBase {
  @Primary()
  public Id: number;

  public UserId: number;

  public Title: string;

  public Views: number;

  @DateTimeColumn()
  public PublishedAt: DateTime;

  // by name: CfUser is declared below and refers to this class
  @BelongsTo('CfUser', 'UserId', 'Id')
  public Author: SingleRelation<CfUser>;

  @HasManyToMany(CfPostTag, CfTag, { junctionModelSourcePk: 'PostId', junctionModelTargetPk: 'TagId' })
  public Tags: Relation<CfTag, CfPost>;
}

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_users')
export class CfUser extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Email: string | null;

  public Age: number | null;

  @Bool()
  public Active: boolean;

  public Score: number | string | null;

  @DateTimeColumn()
  public CreatedAt: DateTime;

  @HasMany(CfPost, { foreignKey: 'UserId', primaryKey: 'Id' })
  public Posts: Relation<CfPost, CfUser>;
}

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_docs')
export class CfDoc extends ModelBase {
  @Primary()
  public Id: number;

  public Label: string;

  @Json()
  public Body: Record<string, unknown>;
}

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_events')
export class CfEvent extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @DateTimeColumn()
  public At: DateTime;

  @DateTimeColumn()
  public Day: DateTime;
}
