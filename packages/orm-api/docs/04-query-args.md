# Query arguments

Three schema-validated DTOs for the query string. Each carries a `@Schema`; two also carry a
`@Hydrator` that parses the raw string into a usable shape.

As with the rest of this package, these live outside the entry point's `exports`, so the samples
here import them by relative path and are not compile-verified — see
[02-configuration.md](02-configuration.md#why-the-blocks-above-are-not-compile-verified).

## `QueryArgs` — paging and sorting

```ts
@Schema(QueryArgsSchema)
export class QueryArgs {
  public page?: number;
  public perPage?: number;
  public orderDirection?: SortOrder;
  public order?: string;
}
```

Schema:

```json
{
  "type": "object",
  "properties": {
    "page": { "type": "number" },
    "perPage": { "type": "number" },
    "orderDirection": { "type": "string", "enum": ["ASC", "DESC", "asc", "desc"] },
    "order": { "type": "string" }
  }
}
```

No hydrator — the values arrive as-is. Two things the schema does **not** do:

- **No minimum on `page` or `perPage`.** A negative `perPage` reaches your code. `take()` rejects
  a negative count, but bound it yourself rather than relying on an exception.
- **No constraint on `order`.** It is a free-form string that you are about to pass to the query
  builder as a column name. Whitelist it.

```ts
const SORTABLE = ['Id', 'Title', 'CreatedAt'];

const perPage = args?.perPage && args.perPage > 0 ? Math.min(args.perPage, 100) : 25;
const page = args?.page && args.page > 0 ? args.page : 0;

const query = model.query().select('*').take(perPage).skip(page * perPage);

if (args?.order && SORTABLE.includes(args.order)) {
  query.order(args.order, args.orderDirection ?? SortOrder.ASC);
}
```

Note that the ORM's builder does validate a column against the model descriptor when the builder
has a model — `order` on an unknown column throws — so the whitelist is defence in depth rather
than the only guard. It is still worth having: a valid-but-private column would otherwise be
sortable.

## `QueryIncludes` — relation population

```ts
@Hydrator(QueryIncludesHydrator)
@Schema(QueryIncludesSchema)
export class QueryIncludes {
  [key: string]: string;
}
```

The hydrator turns a comma-separated list of dotted paths into a nested object using lodash's
`_.set`:

```
?includes=Author,Comments.Author
```

becomes

```json
{ "Author": {}, "Comments": { "Author": {} } }
```

which is exactly the object form `SelectQueryBuilder.populate()` accepts:

```ts
query.populate(includes as {});
```

An absent value hydrates to `{}`, so `populate({})` is a harmless no-op.

Note the **mismatch** between the schema and the hydrator: `QueryIncludesSchema` declares

```json
{ "type": "array", "items": { "type": "string" } }
```

while the hydrator expects a **string** and calls `.split(',')` on it. Whether validation runs
before or after hydration determines which shape has to satisfy the schema; the safest reading is
that this schema does not describe what the hydrator consumes. Treat it as unvalidated input.

An unknown relation name reaching `populate()` throws
`Relation X not exists in model Y`, so a bad include is an error rather than a silent no-op.

## `QueryFilter` — filtering

```ts
@Hydrator(GetFilterHydrator)
@Schema(QueryFilterSchema)
export class QueryFilter {
  [key: string]: IQueryFilterEntry;
}
```

The hydrator `JSON.parse`s the raw value, or yields an empty `QueryFilter` when absent:

```ts
export class GetFilterHydrator extends ArgHydrator {
  public async hydrate(input: string): Promise<any> {
    if (input) {
      return new QueryFilter(JSON.parse(input));
    }
    return new QueryFilter({});
  }
}
```

The shape is a **map of column → `{ val, op }`**:

```
?filter={"Title":{"val":"typescript","op":"like"},"Views":{"val":100,"op":">"}}
```

`IQueryFilterEntry` is `{ val: string; op?: string }`.

Schema:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "key": { "type": "string" },
      "val": { "type": "number" },
      "op": { "type": "string", "enum": ["=", "!=", "like", "<", ">", "<=", ">="] }
    },
    "required": ["key", "val"]
  }
}
```

Three mismatches to be aware of before relying on this schema:

- It describes an **array** of `{ key, val, op }`; the class is a **map** of column →
  `{ val, op }`. The hydrator produces the map.
- It types `val` as a **number**, while `IQueryFilterEntry.val` is a **string**.
- `JSON.parse` on malformed input throws a raw `SyntaxError`, which surfaces as a `500` rather
  than a `400`.

Unlike `@spinajs/orm-http`'s filtering, nothing here restricts **which columns** are filterable
or **which operators** each column allows. Applying a `QueryFilter` straight to a query lets a
client filter on any column of the table.

```ts
// Bound it yourself.
const FILTERABLE: Record<string, string[]> = {
  Title: ['=', 'like'],
  Views: ['=', '>', '<'],
};

for (const [column, entry] of Object.entries(filter)) {
  const allowed = FILTERABLE[column];
  if (!allowed) continue;

  const op = entry.op ?? '=';
  if (!allowed.includes(op)) continue;

  query.andWhere(column, op as any, entry.val);
}
```

If you want operator whitelisting declared on the model itself, use `@spinajs/orm-http`'s
`@Filterable` / `@Filter` instead — see
[its filtering docs](../../orm-http/docs/03-filtering.md).

## Using all three

```ts
@Get(':model')
public async list(
  @ModelType() model: IModelStatic,
  @Query() args: QueryArgs,
  @Query() includes: QueryIncludes,
  @Query() filter: QueryFilter,
) {
  const perPage = args?.perPage && args.perPage > 0 ? Math.min(args.perPage, 100) : 25;
  const page = args?.page && args.page > 0 ? args.page : 0;

  const query = model.query().select('*');

  if (includes) {
    query.populate(includes as {});
  }

  applyFilter(query, filter);           // your whitelisting, as above

  const totalCount = await (query.clone() as any).selectCount();

  query.take(perPage).skip(page * perPage);

  const data = await query;

  return new Ok(this.Transformer.transform(data as ModelBase[], { model: model as any, totalCount, currentPage: page, perPage }));
}
```

The parameter **name** is the query-string key `@Query()` reads, so these arrive as `?args=`,
`?includes=` and `?filter=` respectively. Rename the parameters to change the keys.

## Summary

| DTO | Query key | Hydrated to | Validated |
| --- | --- | --- | --- |
| `QueryArgs` | the parameter name | Plain object | Types only — no bounds, no column whitelist |
| `QueryIncludes` | the parameter name | Nested object for `populate()` | Schema does not match the hydrator's input |
| `QueryFilter` | the parameter name | Map of column → `{ val, op }` | Schema does not match the hydrator's output |

All three are usable; none of them is a security boundary on its own.
