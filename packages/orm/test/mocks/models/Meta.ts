import { Connection, Model, BelongsTo, SingleRelation } from './../../../src/index.js';
import { MetadataModel } from '../../../src/metadata.js';
import _ from 'lodash';
import type { MetaTest } from './MetaTest.js';

@Connection('sqlite')
@Model('users_metadata')
export class Meta extends MetadataModel<Meta> {
  @BelongsTo('MetaTest')
  public Owner: SingleRelation<MetaTest>;
}
