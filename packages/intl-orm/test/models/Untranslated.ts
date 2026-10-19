import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

/** A model of a table with a translated sibling model, but no @Translate() column and no relation of its own. */
@Connection('default')
@Model('owner2')
export class Untranslated extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;
}
