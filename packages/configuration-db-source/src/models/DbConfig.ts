/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable prettier/prettier */
import { Connection, Primary, Model, ModelBase, Json } from '@spinajs/orm';
import _ from 'lodash';
import { DateTime } from 'luxon';
// type-only: @Json on Meta + emitDecoratorMetadata would otherwise retain this
// interface as a runtime value import and break ESM loading.
import type { ConfigurationEntryType, IConfigurationEntryMeta } from '../types.js';
import { DbConfigValue } from '../converter.js';

@Connection('default')
@Model('configuration')
export class DbConfig<T = unknown> extends ModelBase {
  @Primary()
  public Id!: number;

  public Slug!: string;

  // Value & Default are stored as text; the `Type` column drives conversion to
  // and from the database (see DbConfigValueConverter). Both read the same Type.
  @DbConfigValue('Type')
  public Value?: T;

  public Group!: string;

  public Label?: string;

  public Description?: string;

  // stored as JSON text - the converter parses it to an object on read and
  // stringifies it on write ( so exposeOptions.meta objects persist correctly )
  @Json()
  public Meta?: IConfigurationEntryMeta;

  public Required!: boolean;

  public Type!: ConfigurationEntryType;

  public Watch!: boolean;

  public Exposed!: boolean;

  @DbConfigValue('Type')
  public Default?: T;

  public Environment?: string;
}

/**
 * Deep equality that understands luxon DateTime values.
 *
 * `_.isEqual` compares DateTime instances by their (large, internal) own
 * properties, which is both fragile and can report equal instants as
 * different. This compares DateTimes by their instant instead and falls back
 * to lodash defaults for everything else (so arrays / objects of DateTimes,
 * eg. *-range types, are compared element-wise).
 */
export function isConfigValueEqual(a: unknown, b: unknown): boolean {
  return _.isEqualWith(a, b, (x: unknown, y: unknown) => {
    if (DateTime.isDateTime(x) && DateTime.isDateTime(y)) {
      return x.toMillis() === y.toMillis();
    }
    // returning undefined defers to lodash's default comparison
    return undefined;
  });
}
