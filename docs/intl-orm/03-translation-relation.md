# Translation relation

`IntlModelRelation` is the relation that `translate(lang)` attaches to a select builder. At compile time it adds an `IntlModelMiddleware`, which reads `intl_resources` after hydration and writes the values into the models. Replace or subclass them to change how translations are looked up, eg. to add a fallback language.

> `translate(lang)` passes its constructor arguments in the wrong order in the current source, so this relation fails before your override runs. See [Query translation](02-query-translation.md#important-behaviour).

## How it works

1. [`translate(lang)`](02-query-translation.md) calls `container.resolve(IntlModelRelation, [...])` on the builder's container. `@Inject(Container)` puts the container first; the array follows.
2. The constructor calls `NativeOrmRelation` with a fixed descriptor: `Name: 'Translations'`, `Type: RelationType.Many`, `TargetModel: IntlResource`, empty `ForeignKey` and `PrimaryKey`, `SourceModel: null`.
3. `NativeOrmRelation` builds the relation query: it resolves the `IntlResource` connection and a `'SelectQueryBuilder'` owned by the relation. The constructor sets its source to `intl_resources` under the relation alias.
4. `execute()` (inherited) runs no callback; `translate()` passes none.
5. The driver compiles the parent builder. `IntlModelRelation.compile()` adds `new IntlModelMiddleware(lang, relationQuery, modelDescriptor, parentRelation)` to the parent builder, once: `_compiled` guards a second `toDB()`.
6. After the parent query hydrates its models, `IntlModelMiddleware.afterHydration(models)`:
   1. collects the first primary key column of each model; with none, returns `[]`;
   2. adds `whereIn('ResourceId', keys)`, `where('Resource', descriptor.Name)` and `where('Lang', lang)` to the relation query;
   3. adds an inner middleware that, for each model, copies `Value` into the property named by `Column` and calls `setLanguage(lang)`;
   4. awaits the relation query.
7. `IntlModelRelation.translate()` is empty, so the internal query is never translated itself.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `IntlModelRelation` | Class token `IntlModelRelation`, `@NewInstance()`: one per `translate()` call. `@Inject(Container)`. The package registers nothing; it resolves the class itself. | `IntlModelRelation` | none | `DI.register(MyRelation).as(IntlModelRelation)` before the first translated query. Override `compile()` to install another middleware. |
| `IntlModelMiddleware` | Not in DI: `new`-ed in `IntlModelRelation.compile()`; implements `IBuilderMiddleware` | `IntlModelMiddleware` | none | Subclass it and construct your subclass from an overridden `compile()`. Override `afterHydration()`. |

Constructor and members:

| Member | Meant to be overridden | Behaviour |
| --- | --- | --- |
| `IntlModelRelation(container, lang, query, modelDescriptor, parentRelation?)` | extend, keep the signature | `lang`, `modelDescriptor` are stored as protected `_lang`, `_mDescriptor`; the relation query is `_relationQuery`. |
| `IntlModelRelation.compile()` | yes | Adds the middleware; must set `_compiled = true` and return early when already set. |
| `IntlModelRelation.translate(lang)` | no | Empty. |
| `IntlModelMiddleware(lang, relationQuery, modelDescriptor, owner)` | extend, keep the signature | Stored as protected `_lang`, `_relationQuery`, `_description`, `_owner`. |
| `IntlModelMiddleware.afterHydration(models)` | yes | Loads and assigns translations as in step 6. |
| `afterQuery(data)`, `modelCreation()`, `afterQueryCreation()` | rarely | Pass-through, `null` (default model creation), no-op. |

### `IntlModelRelation`: custom implementation with a fallback language

A shop with partial translations wants German pages to show the English text, not the Polish base value, where a German row is missing. Subclass the middleware to read both languages, subclass the relation to install it, and register the relation under `IntlModelRelation` at startup, before the first translated query.

```ts sample
import { Container, DI, Inject, NewInstance } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import { IntlModelMiddleware, IntlModelRelation, IntlResource, Translatable } from '@spinajs/intl-orm';

const FALLBACK_LANG = 'en_GB';

/** Applies FALLBACK_LANG rows first, then the requested language over them. */
export class FallbackIntlModelMiddleware extends IntlModelMiddleware {
  public async afterHydration(models: ModelBase[]): Promise<any[]> {
    const pk = this._description.PrimaryKey[0];
    const ids = models.map((m) => (m as any)[pk] as number);
    if (ids.length === 0) {
      return [];
    }

    const query = IntlResource.where('Resource', this._description.Name).whereIn('ResourceId', ids).whereIn('Lang', [FALLBACK_LANG, this._lang]);
    // keep IntlQueryMiddleware off the lookup itself
    query.AllowTranslate = false;
    const rows = await query;

    for (const lang of [FALLBACK_LANG, this._lang]) {
      for (const row of rows.filter((r) => r.Lang === lang)) {
        const model = models.find((m) => (m as any)[pk] === row.ResourceId);
        if (model) {
          (model as any)[row.Column] = row.Value;
        }
      }
    }

    models.forEach((m) => (m as Translatable).setLanguage(this._lang));
    return models;
  }
}

@NewInstance()
@Inject(Container)
export class FallbackIntlModelRelation extends IntlModelRelation {
  public compile(): void {
    if (this._compiled) {
      return;
    }

    this._query.middleware(new FallbackIntlModelMiddleware(this._lang, this._relationQuery, this._mDescriptor, this.parentRelation!));
    this._compiled = true;
  }
}

export function useFallbackTranslations(): void {
  DI.register(FallbackIntlModelRelation).as(IntlModelRelation);
}
```

## Important behaviour

- The relation is resolved from the builder's container, which falls back to the root. A registration in the root container applies to every connection.
- `IntlModelRelation` lives in the parent builder's relation list. It adds no join and no column to the parent `SELECT`.
- The lookup filters on `descriptor.Name`, the class name, which must match the `Resource` written by [`Translatable.update()`](01-translatable-models.md).
- The stock middleware compares `ResourceId === primaryKey` strictly. Integer keys only.
- For a `BelongsTo` owner and for any other owner, the stock middleware writes the same properties; the branch on `BelongsToRelation` has no effect.
- `afterHydration()` adds its `where` clauses to the shared relation query. The relation is `@NewInstance()`, so each `translate()` call gets a fresh query.

## Best practices

- Keep the `_compiled` guard in an overridden `compile()`. `toDB()` compiles a builder more than once, and without the guard the middleware is added twice.
- Set `AllowTranslate = false` on any model query you run from inside the middleware, so [`IntlQueryMiddleware`](04-automatic-translation.md) does not try to translate it.
- Register the replacement once, at startup. `@NewInstance()` means every later `translate()` picks it up without uncaching.

## Related

- [Query translation](02-query-translation.md): `translate(lang)`, which resolves this relation.
- [Relations](../orm/06-relations.md): `NativeOrmRelation` and the relation lifecycle.
- [Query builder](../orm/05-query-builder.md): `IBuilderMiddleware` hooks.
- [Lifetimes](../di/04-lifetimes.md): `@NewInstance()`.
