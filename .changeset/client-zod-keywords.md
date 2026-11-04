---
"@spinajs/client": minor
---

`client.zod.ts` maps the keywords zod has no native form for, as the server's Ajv applies them: `not`, `if`/`then`/`else`, `contains`, `patternProperties`, `propertyNames`, `dependencies` and `minProperties`/`maxProperties`. The object keywords and `uniqueItems` check the value as sent, so a JSON `__proto__` key counts as it does on the server.

The keywords only an explicit `@Schema` carries are mapped as `DataValidator` applies them. `$data` in `const` and the numeric and length limits of a property is checked on the parent object, and the issue is reported at the property, so `confirm: { const: { $data: '1/password' } }` works with `zodResolver`. `$merge` and `$patch` are resolved when the file is generated. From ajv-keywords, `range`, `exclusiveRange`, `transform`, `regexp` without flags and `uniqueItemProperties` are mapped. The other ajv-keywords, any other `$data`, and a keyword the server's Ajv does not know (one an app adds in `createAppAjv()`) are dropped with `ZOD003`.

A schema that breaks the draft-07 meta-schema accepts any value, as the server leaves it unchecked: for example a zero `multipleOf`, a fractional length or an empty `enum`. A `$schema` below a schema's root no longer does.

A node with a root `not`, `if`, `patternProperties`, `propertyNames`, `dependencies`, `min/maxProperties` or `uniqueItems`, or a `transform`ed string, has `unknown` as its zod input type, because the check reads the value before the schema parses it. `zodResolver` then types those form fields loosely; the output type is unchanged.

`@spinajs/client/formats` compares values as the fixed server does (`jsonEqual`): `ajvEqual` and `ajvUniqueItems` no longer throw on an own `valueOf` or `toString` key, and they count a repeated `'__proto__'` string as a duplicate. `ajvUniqueItems` no longer takes the items' types. New helpers back the generated checks: `jsonEqual`, `minProperties`, `maxProperties`, `propertyNames`, `patternProperties`, `additionalProperties`, `dependencies`, `contains`, `dataRef`, `dataLimit` and `uniqueItemProperties`.
