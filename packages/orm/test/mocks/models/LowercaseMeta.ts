import { Connection, Model, BelongsTo, SingleRelation, Primary } from '../../../src/index.js';
import { MetadataModel } from '../../../src/metadata.js';
import type { LowercaseMetaOwner } from './LowercaseMetaOwner.js';

/**
 * Mimics a metadata table whose DB columns are lowercase (`key`, `value`, `owner_id`) while
 * the inherited MetadataModel base exposes capital-cased `Key`/`Value`. The overridden
 * setters bridge those two cases by delegating writes to the lowercase fields.
 */
@Connection('sqlite')
@Model('lowercase_metadata')
export class LowercaseMeta extends MetadataModel<LowercaseMeta> {
  @Primary()
  public id: number;

  public owner_id: number;

  public key: string;

  public value: string;

  @BelongsTo('LowercaseMetaOwner', 'owner_id', 'id')
  public Owner: SingleRelation<LowercaseMetaOwner>;

  public get Key() {
    return this.key;
  }

  public set Key(v: string) {
    this.key = v;
  }

  public get Value() {
    return this.value;
  }

  public set Value(v: string) {
    this.value = v;
  }
}
