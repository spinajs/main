---
"@spinajs/client": minor
---

New zero-dependency subpath `@spinajs/client/formats`: predicates that answer exactly as the server's Ajv does. It ports the `ajv-formats` 2.1.1 full-mode formats (`isDate`, `isDateTime`, `isEmail`, `isUri`, … one per format, looked up with `formatPredicate(name)` and `numberFormatPredicate(name)`), the `decimal` format, the Ajv checks for `minLength`/`maxLength` in code points (`minCodePoints`, `maxCodePoints`), `multipleOf` (`ajvMultipleOf`), deep equality for `const`/`enum` (`ajvEqual`) and `uniqueItems` (`ajvUniqueItems`), and the `coerceTypes: 'array'` conversions the server applies to query, path, header and cookie values (`ajvCoerce`, `coerceNumber`, `coerceInteger`, `coerceBoolean`, `coerceNull`, `coerceString`, `coerceArray`). It imports nothing, so it is safe in a browser bundle. Note that `ajv-formats` 2.1.1 accepts a `date-time` without a time zone, and `isDateTime` does the same.
