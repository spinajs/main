import { BelongsTo, Connection, HasMany, Model, ModelBase, Primary, Relation, SingleRelation, Uuid } from '@spinajs/orm';

@Connection('postgres')
@Model('pg_auto_key')
export class PgAutoKey extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('postgres')
@Model('pg_uuid_key')
export class PgUuidKey extends ModelBase {
  @Primary({ generated: 'uuid' })
  public Id: string;

  public Name: string;
}

@Connection('postgres')
@Model('pg_native_uuid')
export class PgNativeUuid extends ModelBase {
  @Primary()
  public Id: string;

  public Name: string;
}

@Connection('postgres')
@Model('pg_composite_key')
export class PgCompositeKey extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;

  public Name: string;
}

@Connection('postgres')
@Model('pg_bytes_uuid')
export class PgBytesUuid extends ModelBase {
  @Primary()
  public Id: number;

  @Uuid()
  public Ref: string;
}

@Connection('postgres')
@Model('pg_pet')
export class PgPet extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public person_id: number;

  // by name: PgPerson is declared below and refers to this class
  @BelongsTo('PgPerson', 'person_id', 'Id')
  public Owner: SingleRelation<PgPerson>;
}

@Connection('postgres')
@Model('pg_person')
export class PgPerson extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  public Age: number;

  public City: string | null;

  @HasMany(PgPet, { foreignKey: 'person_id', primaryKey: 'Id' })
  public Pets: Relation<PgPet, PgPerson>;
}
