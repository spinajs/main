import { AutoinjectService } from '@spinajs/configuration';
import { HasMany, HasManyToMany, JunctionTable, ModelBase, Model, Primary, Relation, Virtual } from '@spinajs/orm';
import { Db } from './services.js';

@Model('pets')
export class Pet extends ModelBase {
  @Primary()
  public Id: number;
}

@Model('links')
export class Link extends ModelBase {
  @Primary()
  public Id: number;
}

export class PetNames extends Relation<Pet, Owner> {}

@Model('owners')
export class Owner extends ModelBase {
  @Primary()
  public Id: number;

  @HasMany(Pet)
  public Pets: Relation<Pet, Owner>;

  @HasManyToMany(Link, Pet)
  public Linked: Relation<Pet, Owner>;

  @Virtual()
  public Names: PetNames;

  @JunctionTable()
  public Junction: Link;
}

export class Holder {
  @AutoinjectService('app.db')
  public db: Db;

  @AutoinjectService('app.db', Db)
  public named: Db;
}
