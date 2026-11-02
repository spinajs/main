import { Bool, Connection, CreatedAt, DateTime, HasMany, HasManyToMany, JunctionTable, Model, ModelBase, OneToManyRelationList, Primary, Relation, Set, SoftDelete, UpdatedAt, Virtual } from '@spinajs/orm';
import { DateTime as Instant } from 'luxon';

@Connection('default')
@Model('pets')
export class Pet extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public owner_id: number;
}

@Connection('default')
@Model('owner_tags')
export class OwnerTag extends ModelBase {
  @Primary()
  public Id: number;

  public owner_id: number;

  public tag_id: number;

  public Note: string;
}

@Connection('default')
@Model('tags')
export class Tag extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @JunctionTable()
  public Link: OwnerTag;
}

export class PetNames extends OneToManyRelationList<Pet, Owner> {
  public async populate(): Promise<void> {
    const pets = await Pet.where({ owner_id: this.Owner.Id });
    this.push(...pets);
    this.Populated = true;
  }
}

@Connection('default')
@Model('owners')
export class Owner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @CreatedAt()
  public CreatedAt: Instant;

  @UpdatedAt()
  public UpdatedAt: Instant;

  @SoftDelete()
  public DeletedAt: Instant;

  @DateTime()
  public SeenAt: Instant;

  @Set()
  public Roles: string[];

  @Bool()
  public Active: boolean;

  @HasMany(Pet, { foreignKey: 'owner_id', primaryKey: 'Id' })
  public Pets: Relation<Pet, Owner>;

  @HasManyToMany(OwnerTag, Tag)
  public Tags: Relation<Tag, Owner>;

  @Virtual()
  public Names: PetNames;
}
