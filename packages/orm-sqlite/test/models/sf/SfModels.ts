import { ModelBase, Primary, Connection, Model, BelongsTo, HasManyToMany, Relation, SingleRelation } from '@spinajs/orm';

// A self-referencing many-to-many whose junction has two relations to the same class and a third, unrelated to the link.

@Connection('sqlite')
@Model('sf_friendship')
export class SfFriendship extends ModelBase {
  @Primary()
  public Id: number;

  public person_id: number;

  public friend_id: number;

  public approver_id: number | null;

  @BelongsTo('SfPerson', 'person_id', 'Id')
  public Person: SingleRelation<SfPerson>;

  @BelongsTo('SfPerson', 'friend_id', 'Id')
  public Friend: SingleRelation<SfPerson>;

  @BelongsTo('SfPerson', 'approver_id', 'Id')
  public Approver: SingleRelation<SfPerson>;
}

@Connection('sqlite')
@Model('sf_person')
export class SfPerson extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasManyToMany(SfFriendship, 'SfPerson', {
    targetModelPKey: 'Id',
    sourceModelPKey: 'Id',
    junctionModelTargetPk: 'friend_id',
    junctionModelSourcePk: 'person_id',
  })
  public Friends: Relation<SfPerson, SfPerson>;
}
