# DTO constraints with JSDoc tags

In `prefer` and `require` [manifest mode](../manifest/README.md#runtime-modes), `spinajs build` derives a JSON Schema from the TypeScript type of every DTO. A type says `string` or `number`, not `email` or `at most 10 characters`. JSDoc tags on a property add those limits to the derived schema, so the DTO needs no `@Schema` that repeats its own class.

The tags are read by `packages/compiler/src/schema/jsdoc.ts`. They apply to properties of interfaces, classes and type literals, and to the columns and relations of ORM models.

## Tags

| Tag | Schema keyword | Value |
| --- | --- | --- |
| `@minimum`, `@maximum` | `minimum`, `maximum` | number |
| `@exclusiveMinimum`, `@exclusiveMaximum` | `exclusiveMinimum`, `exclusiveMaximum` | number (draft-07 form: the bound itself) |
| `@multipleOf` | `multipleOf` | number |
| `@minLength`, `@maxLength` | `minLength`, `maxLength` | number |
| `@minItems`, `@maxItems` | `minItems`, `maxItems` | number |
| `@pattern` | `pattern` | the text, as written |
| `@format` | `format` | the text, as written |
| `@title` | `title` | the text, as written |
| `@default` | `default` | parsed as JSON; text that is not JSON stays a string |
| `@example` | `examples` | parsed as JSON like `@default`; each tag appends one item |
| `@uniqueItems` | `uniqueItems` | `true`, or `false` when the tag text is `false` |
| `@deprecated` | `deprecated` | always `true` |
| comment text | `description` | the text of the property's comment, trimmed |

Rules that follow from the code:

- A numeric tag whose text is empty or not a number is skipped without a diagnostic. `@minLength abc` derives nothing.
- `@default 50` is the number `50`, `@default "a"` and `@default a` are the string `"a"`, `@default true` is `true`.
- Any other tag (`@summary`, `@tags`, `@param`, ...) is ignored here. The route tags are on [Documenting routes](../http-swagger/02-documenting-routes.md#jsdoc-tags).
- Tags are not checked against the property type. `@minLength 3` on a `number` is emitted as written, and Ajv ignores it for numbers.
- Tags do not change `required` or `additionalProperties`. Required comes from the `?` modifier, and derived object schemas are closed (see [Validation from the manifest](../http/04-route-arguments.md#validation-from-the-manifest)).
- A tag overrides a keyword of the same name that the type already derived.

## Example

```ts
export interface JDoc {
  /**
   * The display name
   * @minLength 1
   * @maxLength 10
   */
  name: string;
  /**
   * @minimum 0
   * @maximum 100
   * @default 50
   */
  score: number;
  /**
   * @pattern ^[a-z]+$
   * @format email
   */
  email: string;
  /** @example 2020-01-01 */
  when: string;
  /** @deprecated */
  old?: string;
  /**
   * @minItems 1
   * @uniqueItems
   */
  tags: string[];
}
```

The compiler derives this schema (the `$id` the compiler assigns is left out). It is the expectation of the `JDoc` case in `packages/compiler/test/schema/derive.test.ts`:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "score", "email", "when", "tags"],
  "properties": {
    "name": { "type": "string", "description": "The display name", "minLength": 1, "maxLength": 10 },
    "score": { "type": "number", "minimum": 0, "maximum": 100, "default": 50 },
    "email": { "type": "string", "pattern": "^[a-z]+$", "format": "email" },
    "when": { "type": "string", "examples": ["2020-01-01"] },
    "old": { "type": "string", "deprecated": true },
    "tags": { "type": "array", "items": { "type": "string" }, "minItems": 1, "uniqueItems": true }
  }
}
```

Used as `@Body() body: JDoc`, a body with `"name": ""` or `"tags": ["a", "a"]` answers 400.

## When the schema applies

- **Mode.** Derived validation runs in `prefer` and `require` only. In `off`, or without a manifest, the tags do nothing at runtime. Rebuild the manifest (`spinajs build`) after you edit a tag.
- **Precedence.** An explicit schema always wins and the derived one is then not used, tags included: `route.Schema[paramName]`, the schema given to the decorator, the class `@Schema` (a JSON Schema or a [Standard Schema](03-schema-decorator.md#standard-schema)). A class that keeps its `@Schema` ignores the tags on its properties. To move a DTO to tags, delete the `@Schema` and the tags take over. While both exist, `spinajs doctor` rule `SCH003` warns when the explicit schema differs structurally from the derived one, which shows what the tags would change.
- **Which arguments.** The ones [listed for derived validation](../http/04-route-arguments.md#validation-from-the-manifest): `@Body()`, `@Query()`, `@Param()`, `@Header()`, `@Cookie()` and the `*Field()` decorators. Socket contract payloads are validated against the same kind of schema ([Server-enforced contracts](../http-socket/02-controllers.md#server-enforced-contracts)).

## Formats and strictness

The derived schemas are compiled by their own Ajv instance with `ajv-formats`, so `@format` accepts `email`, `date`, `date-time`, `time`, `duration`, `uri`, `uri-reference`, `hostname`, `ipv4`, `ipv6`, `uuid`, `regex` and the other formats of [ajv-formats](https://github.com/ajv-validator/ajv-formats). That instance runs with `strict: false`: an unknown format name is ignored and accepts every value, so check the spelling. Socket contract payloads are compiled with `strictSchema: true` instead: an unknown format there fails to compile, which fails the boot in `require` and skips that contract with a warning in `prefer`.

SpinaJS adds one format of its own, `decimal`, to the derived validator, to the socket contract validator and to `DataValidator`. It accepts plain decimal text: an optional `-`, an integer part without leading zeros, and an optional fraction, as the regex `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$` says. `'12.50'`, `'0'` and `'-0.5'` pass; `'1e3'`, `'01'`, `'.5'` and `'+1'` do not. Use it for a money amount or any value you keep as a string to avoid floating-point rounding:

```ts
export interface PriceDto {
  /** @format decimal */
  amount: string;
}
```

A property typed as a decimal.js `Decimal` or a big.js `Big` gets `format: 'decimal'` without a tag (see [Schema derivation](../compiler/README.md#schema-derivation)). Both libraries write very large and very small values in exponent notation (`new Decimal('1e21').toJSON()` is `'1e+21'`), which the format rejects. Send such values with `toFixed()`.

Two things differ from a `@Schema` run by `DataValidator`:

- `@default` is documentation for tools such as OpenAPI. The derived validator does not set `useDefaults`, so a missing value is not filled in.
- `ajv-keywords` and `$merge` are not available. Tags cannot produce them, so this only matters when you compare with a hand-written `@Schema`.

Query, path and header values are coerced before the check (`?score=5` is the number `5`), as described on [Validation from the manifest](../http/04-route-arguments.md#validation-from-the-manifest); a JSON body is never coerced.

## Related

- [The `@Schema` decorator](03-schema-decorator.md): the explicit schema that overrides the derived one.
- [Schema derivation](../compiler/README.md#schema-derivation): how schemas are derived and the `SCH*` diagnostics.
- [What is new in 4.0](../whats-new-4.0.md): where derived validation fits.
