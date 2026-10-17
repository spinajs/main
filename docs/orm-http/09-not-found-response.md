# Not-found response

`OrmNotFound` maps `OrmNotFoundException` to `404 Not Found`, rendered with the `notFound.pug` template for HTML clients. `@FromModel()`, `@Relation()`, `firstOrFail()` and `firstOrThrow(new OrmNotFoundException(...))` all raise that exception, so a missing row is a `404` with no handler code.

## How it works

1. At import, `@HandleException([OrmNotFoundException])` puts `OrmNotFound` in the http error map (`__http_error_map__`) under the key `'OrmNotFoundException'`. `@Injectable(Response)` also registers it under `Response`.
2. A route throws `OrmNotFoundException`, or a route argument does.
3. The http error handler walks the error's class chain and takes the first class name found in the map: `OrmNotFoundException` → `OrmNotFound`.
4. It builds `new OrmNotFound({ ...error, message })` and calls `execute()`: status `404`, template `notFound.pug`, content negotiated by the `Accept` header.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `404` for missing rows | `__http_error_map__` value map, key `'OrmNotFoundException'`; a new response instance per error | `OrmNotFound` | `NotFound` from `@spinajs/http` (handles `ResourceNotFound`) | Your own `Response` subclass with `@HandleException([OrmNotFoundException])`, imported after `@spinajs/orm-http`. Override `_errorCode`, `_template` or `prepareResponse()`. |

### OrmNotFound: a JSON error body with a stable code

The error map keeps one response per exception name, and the last `@HandleException` for a name replaces the earlier one. Import your module after `@spinajs/orm-http`.

```ts sample
import { HandleException, HTTP_STATUS_CODE, IResponseOptions, Response } from '@spinajs/http';
import { OrmNotFoundException } from '@spinajs/orm';
import '@spinajs/orm-http';

@HandleException([OrmNotFoundException])
export class ResourceMissingResponse extends Response {
  protected _errorCode = HTTP_STATUS_CODE.NOT_FOUND;
  protected _template = 'notFound.pug';

  constructor(error: string | object | Promise<unknown>, protected options?: IResponseOptions) {
    super(error, options);
  }

  /** Clients branch on `code`; the stack and other internals never leave the server. */
  protected async prepareResponse() {
    const error = (await super.prepareResponse()) as { message?: string };
    return { code: 'RESOURCE_NOT_FOUND', message: error?.message ?? 'Resource not found' };
  }
}
```

## Important behaviour

- The map is keyed by class name and walked from the thrown class up. A subclass of `OrmNotFoundException` without its own entry also answers `404`.
- Messages reach the client: `Resource not found` from `@FromModel()`, `<Model> referenced by '<field>' not found` from `@Relation()`. Outside production the stack is attached as well.
- `OrmException` (for example `primary key cannot be null` from `DbModelHydrator`) is not mapped and answers `500`.

## Best practices

- Throw `OrmNotFoundException` from services that look rows up, so every missing row answers the same way.
- Use `firstOrThrow(error)` when you need another status or message for one query; it takes an `Error` or a function receiving the compiled query.

## Examples

### Answer 404 from a hand-written lookup

```ts sample
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Slug: string;
}

@BasePath('articles')
export class ArticleBySlugController extends BaseController {
  @Get('by-slug/:slug')
  public async bySlug(@Param() slug: string) {
    // firstOrFail() throws OrmNotFoundException; OrmNotFound turns it into 404.
    const article = await Article.select().where('Slug', slug).firstOrFail();
    return new Ok(article.dehydrate());
  }
}
```

## Related

- [Error handling](../http/11-error-handling.md): the error map, `@HandleException` and the error handler.
- [Responses](../http/10-responses.md): the `Response` base class and templates.
- [Route arguments](02-route-args.md) and [DTO relations](04-dto-relations.md): where the exception comes from.
