/**
 * Configuration entry types.
 *
 * Every row stores its `Value` as text plus a `Type` that decides how the text
 * is converted to/from a JS value. The same `Type` set is used for
 * `exposeOptions.type`. Values are stored in canonical form (ISO dates/times,
 * decimal numbers, `true`/`false` booleans).
 *
 *   Type             stored text format          runtime JS value
 *   ---------------  --------------------------  ------------------------------
 *   string / file    as-is                       string
 *   oneOf            as-is                       string
 *   number           integer text                number
 *   float / range    decimal text                number (range validated via meta.min/max)
 *   boolean          'true' / 'false'            boolean
 *   json             JSON                         parsed object/array
 *   manyOf           JSON array                   string[]
 *   date             ISO date (yyyy-MM-dd)        luxon DateTime
 *   time             ISO time (HH:mm:ss)          luxon DateTime
 *   datetime         ISO 8601                     luxon DateTime
 *   date-range       'd1;d2' (ISO dates)          DateTime[]
 *   time-range       't1;t2' (ISO times)          DateTime[]
 *   datetime-range   'iso1;iso2'                  DateTime[]
 *
 * Conversion is done by `DbConfigValueConverter` (a subclass of the ORM's
 * `UniversalValueConverter`), keyed off the row's `Type` column. The same
 * converter is used by the model, the source and when persisting exposed values.
 *
 * Run:
 *   node lib/mjs/examples/04-entry-types.js
 */
import { DateTime } from 'luxon';
import { DbConfig, DbConfigValueConverter } from '@spinajs/configuration-db-source';

// --- how stored text maps to runtime values --------------------------------
// fromDB(value, rawRow, { TypeColumn }) reads the type off the row's Type column
const converter = new DbConfigValueConverter();
const read = (value: unknown, type: string) => converter.fromDB(value, { Type: type }, { TypeColumn: 'Type' });

console.log(read('42', 'number')); //          -> 42  (number)
console.log(read('10.5', 'range')); //         -> 10.5 (number)
console.log(read('true', 'boolean')); //       -> true
console.log(read('{"a":1}', 'json')); //       -> { a: 1 }
console.log(read('["a","b"]', 'manyOf')); //   -> ['a', 'b']
console.log(read('2026-06-24', 'date')); //    -> DateTime
console.log(read('2026-06-24;2026-06-25', 'date-range')); // -> DateTime[]

// --- seeding typed rows programmatically -----------------------------------
// Store each `Value` in the canonical text form documented above for its `Type`;
// it is converted back into the corresponding JS value when the config loads.
export async function seed() {
  // `oneOf` stores the selected value; the allowed set lives in `Meta`
  // (admin-UI validation metadata, persisted as JSON text).
  await DbConfig.insert({
    Slug: 'billing.currency',
    Value: 'EUR',
    Type: 'oneOf',
    Group: 'billing',
    Exposed: true,
  });

  await DbConfig.insert({
    Slug: 'billing.trialEnds',
    Value: DateTime.now().plus({ days: 30 }).toISO(), // datetime -> ISO text
    Type: 'datetime',
    Group: 'billing',
    Exposed: true,
  });

  await DbConfig.insert({
    Slug: 'billing.discountRange',
    Value: '5', // a bounded number (min/max enforced by an admin UI via Meta)
    Type: 'range',
    Group: 'billing',
    Exposed: true,
  });
}
