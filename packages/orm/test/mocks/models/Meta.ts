import { Connection, Model, BelongsTo, MetadataModel, SingleRelation } from './../../../src/index.js';
import _ from 'lodash';
import type { MetaTest } from './MetaTest.js';

@Connection('sqlite')
@Model('users_metadata')
export class Meta extends MetadataModel<Meta> {
  @BelongsTo('MetaTest')
  public Owner: SingleRelation<MetaTest>;
}
