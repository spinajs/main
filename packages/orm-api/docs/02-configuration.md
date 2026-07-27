# Configuration

## The bundled config

`src/config/orm-api.ts` ships a configuration fragment that `@spinajs/configuration` merges in
when the package is loaded:

```ts
const ormHttp = {
  system: {
    dirs: {
      controllers: [dir(`node_modules/@spinajs/orm-http/lib/${isESMMode ? 'mjs/controllers' : 'cjs/controllers'}`)],
      schemas: [dir(`node_modules/@spinajs/orm-http/lib/${isESMMode ? 'mjs/schemas' : 'cjs/schemas'}`)],
    },
  },
  api: {
    endpoint: {
      transformer: {
        service: 'JsonApiCollectionTransformer',
      },
    },
  },
};
```

Three things about it are worth knowing before you rely on it.

**The controllers path does not exist.** It points into `@spinajs/orm-http`, which has no
`controllers` directory — only `response-methods` and `schemas`. No controller is contributed by
this configuration.

**It points at the wrong package anyway.** This is `orm-api`'s config; the paths name
`orm-http`. The commented-out `JsonApi` controller lives in *this* package's `src/controllers`.

**The default transformer name does not resolve.** `JsonApiCollectionTransformer` is not
registered anywhere in this repository. The transformer that *is* registered is
`PlainJsonCollectionTransformer`.

Set the transformer explicitly:

```ts sample
import { FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

export class AppConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = _.merge(this.Config, {
      api: {
        endpoint: {
          transformer: {
            // The implementation this repository actually registers.
            service: 'PlainJsonCollectionTransformer',
          },
        },
      },
      system: {
        dirs: {
          // Point at YOUR controllers.
          controllers: [`${process.cwd()}/lib/controllers`],
        },
      },
    });
  }
}
```

## Configuration keys

| Key | Meaning |
| --- | --- |
| `api.endpoint.transformer.service` | DI name of the `CollectionApiTransformer` implementation used to shape list and single-resource responses. |
| `system.dirs.controllers` | Directories `@spinajs/http` scans for controllers. |
| `system.dirs.schemas` | Directories `@spinajs/validation` scans for JSON schemas. |

Everything else — connections, pools, migrations — is ORM configuration; see
[the core's configuration page](../../orm/docs/02-configuration.md).

## Resolving the configured transformer

```ts
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';
import { CollectionApiTransformer } from '@spinajs/orm-api/lib/mjs/interfaces.js';

export async function transformer(): Promise<CollectionApiTransformer> {
  const cfg = await DI.resolve(Configuration);
  const service = cfg.get<string>('api.endpoint.transformer.service', 'PlainJsonCollectionTransformer');

  return await DI.resolve<CollectionApiTransformer>(service);
}
```

Provide a default when reading the key, so a missing or stale value does not resolve `undefined`.

## Registering your own transformer

```ts
import { Injectable } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import { CollectionApiTransformer, ITransformOptions } from '@spinajs/orm-api/lib/mjs/interfaces.js';

@Injectable(CollectionApiTransformer)
export class EnvelopeTransformer extends CollectionApiTransformer {
  public transform(data: ModelBase<unknown> | ModelBase<unknown>[], options?: ITransformOptions): unknown {
    if (Array.isArray(data)) {
      return {
        Data: data.map((x) => x.toJSON()),
        Meta: {
          Total: options?.totalCount ?? data.length,
          Page: options?.currentPage ?? 0,
          PerPage: options?.perPage ?? data.length,
        },
      };
    }

    return { Data: data.toJSON() };
  }
}
```

Register it under a name if you want to select it through configuration:

```ts
import { DI } from '@spinajs/di';
import { PlainJsonCollectionTransformer } from '@spinajs/orm-api/lib/mjs/PlainJsonCollectionTransformer.js';

export function register() {
  DI.register(PlainJsonCollectionTransformer).as('PlainJsonCollectionTransformer');
}
```

## Why the blocks above are not compile-verified

Every other sample in these docs is extracted and type-checked by `npm run docs:check`. The
three above are not, and cannot be: `@spinajs/orm-api`'s `package.json` declares
`"exports": { "." : ... }`, and `src/index.ts` re-exports only the four route-argument symbols.
`CollectionApiTransformer`, `PlainJsonCollectionTransformer`, `Crud`, `ModelType`,
`FindModelType` and the DTOs are therefore **not importable from the package at all** — neither
by the bare specifier nor by a deep path, which the `exports` map blocks.

The `@spinajs/orm-api/lib/mjs/...` specifiers are written that way to name the module a symbol
lives in, not because they resolve.

Code inside this repository reaches them by **relative path** from its own source tree, which is
what the package's own tests do:

```ts
import { CollectionApiTransformer } from '../../src/interfaces.js';
```

Adding the missing re-exports to `src/index.ts` would remove the need for either workaround, and
would let these samples be verified like the rest.
