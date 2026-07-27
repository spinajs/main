import { ModelBase, Primary, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';
import { Location } from './Location.js';

@Connection('sqlite')
@Model('offer_location')
export class OfferLocation extends ModelBase {
  @Primary()
  public Id: number;

  // The lazy `ManyToManyRelationList.populate()` path queries the junction model and calls
  // `.populate(TargetModel)` on it, so the junction has to declare where its target-side
  // foreign key points. Without this the lazy path throws
  // `Cannot find relation for model Location in model OfferLocation`.
  //
  // The property MUST be named after the target model: that path reads the result back as
  // `row[Relation.TargetModel.name].Value`. `Localisation` is the junction's FK column.
  //
  // Only the target side is declared: a back-reference to Offer would close an import cycle
  // ( Offer.ts already imports this file ) and the lazy path never needs it.
  @BelongsTo(Location, 'Localisation')
  public Location: SingleRelation<Location>;
}
