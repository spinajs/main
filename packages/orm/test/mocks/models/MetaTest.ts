import { Connection, Primary, Model, HasMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { MetadataRelation } from '../../../src/metadata.js';
import { Meta } from "./Meta.js";
import _ from 'lodash';

@Connection('sqlite')
@Model('MetaTest')
// @ts-ignore
export class MetaTest extends ModelBase {
  @Primary()
  public Id: number;

  /**
   * User additional information. Can be anything
   */
  @HasMany(Meta)
  public Metadata: MetadataRelation<Meta, MetaTest>;
}
