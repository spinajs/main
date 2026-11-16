---
"@spinajs/client": minor
---

Each schema that a query, path, header or cookie argument reaches gets a `<Name>Coerced` variant in `client.zod.ts`, which coerces as Ajv's `coerceTypes: 'array'` does and refuses a coerced `Infinity`. A branch of a coerced `anyOf` or `oneOf` sees the value the branches before it coerced, as Ajv coerces in place, so `X | null` takes `''`, `0` and `false` as `null` the way the server does. `routeSchemas` reads the variant for those arguments, a JSON-shaped query included. A `number`, `boolean` or `bigint` argument is converted as the server converts it before the check, so `'5'` passes a number path parameter. A schema with a strict id (`authn.`, `authz.`) is not coerced as an argument, which `DataValidator` validates; nested in a derived argument it is, as `ManifestValidator` coerces it.

`<Name>Defaults` holds the property `default`s of each object schema, for a form's `defaultValues`; the schemas themselves never apply defaults. Both names step aside (`<Name>Defaults2`) when another schema already takes them.

A coerced variant, and an argument converted by its runtime type, has `unknown` as its zod input type, because the value is rewritten before it is checked. `zodResolver` then types those form fields loosely; the output type is unchanged.

`@spinajs/client/formats` adds `numberArgument`, `booleanArgument` and `isBigIntArgument`, which the conversions of scalar arguments use.
