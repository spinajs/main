# `@spinajs/intl-orm`

Stores per-language values of model columns in the database and loads them back, per entity or per query. It also feeds the `@spinajs/intl` phrase catalogue from a database table.

It does **not** translate many-to-many relations, delete translations when a model is deleted, or fall back to another language when a translation row is missing. The base table always holds the default-language value.

## Install

```sh
npm install @spinajs/intl-orm @spinajs/intl @spinajs/orm
```

Install a dialect driver as well, eg. `@spinajs/orm-sqlite`.

## Features

| Feature | What it does |
| --- | --- |
| [Translatable models](01-translatable-models.md) | Marks columns with `@Translate()` and loads or saves their values per language with the `Translatable` base model |
| [Query translation](02-query-translation.md) | Adds `translate(lang)` to every select builder, a prototype extension that translates the whole result set |
| [Translation relation](03-translation-relation.md) | `IntlModelRelation` and `IntlModelMiddleware`, the overridable relation behind `translate(lang)` |
| [Automatic translation](04-automatic-translation.md) | `IntlQueryMiddleware`, a `QueryMiddleware` that translates selects of models with `@Translate()` columns or relations to the request language |
| [Database translation source](05-database-translation-source.md) | `DbTranslationSource`, a `TranslationSource` that loads `@spinajs/intl` phrases from `intl_translations` |
| [Schema and migration](06-schema-and-migration.md) | The `intl_resources` and `intl_translations` tables, their models and the migration that creates them |

## Quick start

```ts sample
import { Connection, Model, Primary } from '@spinajs/orm';
import { Translatable, Translate } from '@spinajs/intl-orm';

@Connection('default')
@Model('products')
export class Product extends Translatable {
  @Primary()
  public Id: number;

  @Translate()
  public Name: string;

  public Price: number;
}

// Shows a product page in English while the base table keeps the default-language name.
export async function productNameFor(id: number, lang: string): Promise<string> {
  const product = await Product.getOrFail(id);
  await product.translate(lang);
  return product.Name;
}

// Saves the English name into intl_resources; the products row keeps its default-language name.
export async function renameInEnglish(id: number, name: string): Promise<void> {
  const product = await Product.getOrFail(id);
  product.setLanguage('en_GB');
  product.Name = name;
  await product.update();
}
```

Import `@spinajs/intl-orm` once at startup. The import registers the models, the migration, `IntlQueryMiddleware` and `DbTranslationSource`, and patches `SelectQueryBuilder.prototype`.

## Related packages

- [`@spinajs/orm`](../orm/README.md): models, query builder, relations and migrations this package builds on.
- `@spinajs/intl`: language detection (`guessLanguage()`, `defaultLanguage()`), the `intl.defaultLocale` key and the `TranslationSource` list.
- `@spinajs/intl-http`: sets the request language in the async storage that [Automatic translation](04-automatic-translation.md) reads.
- [`@spinajs/orm-http`](../orm-http/README.md): depends on this package.
