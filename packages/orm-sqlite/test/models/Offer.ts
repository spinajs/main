import { ModelBase, Primary, Connection, Model, HasManyToMany, Relation } from '@spinajs/orm';
import { OfferLocation } from './OfferLocation.js';
import { Location } from "./Location.js";

@Connection('sqlite')
@Model('offer')
export class Offer extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasManyToMany(OfferLocation, Location, 'Id', 'Id', 'Localisation', 'Offer_id')
  public Localisations: Relation<Location, OfferLocation>;
}