# Custom language resolution

Change how the request language is chosen without replacing the shipped services: add a middleware that refines `req.storage.language`, add your own argument decorator that injects it, or read it from any service. To replace the shipped services instead, see [`IntHttpMiddleware`](01-request-language.md#inthttpmiddleware-custom-implementation) and [`LangArgument`](02-lang-route-argument.md#langargument-custom-implementation).

## How it works

1. `IntHttpMiddleware` (`Order = 1`) writes `req.storage.language`: the explicit choice from query, cookie or `x-<name>` header, else `intl.defaultLocale`.
2. Every `ServerMiddleware` with a higher `Order` runs after it and can overwrite `req.storage.language`. `HttpServer` sorts the list once, when it resolves.
3. The action runs inside `AsyncLocalStorage.run(req.storage, ...)`, so the last value written is what `guessLanguage()`, templates and `@spinajs/intl-orm` see.
4. `@Lang()` does **not** see the overwrite: `LangArgument` re-reads the request. Use a custom argument (below) to inject the stored value.

| Order | Middleware | Effect on `req.storage` |
| --- | --- | --- |
| `-2` | `RequestStorage` (`@spinajs/http`) | creates `req.storage = {}` |
| `1` | `IntHttpMiddleware` | sets `language` |
| `2` or higher | your refining middleware | overwrites `language` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Refining middleware | `@Injectable(ServerMiddleware)`, singleton, collected as a list by `HttpServer` | none | any number, ordered by `Order` | Extend `ServerMiddleware`, set `Order` above `1`, write `req.storage.language` in `before()`. Import the module before `HttpServer` resolves. |
| Custom language argument | Your `RouteArgs` subclass registered with `@Injectable()` under its class name; singleton; resolved by name from the route parameter `Type` | `LangArgument` for `@Lang()` | any | Pair a `RouteArgs` subclass whose `SupportedType` returns its name with a decorator built from `Route(Parameter('<name>'))`. |
| `IActionLocalStoregeContext.language` | interface field, added to `@spinajs/http` by `declare module` in this package | written by `IntHttpMiddleware` | none | Import `@spinajs/intl-http` (or `import type`) to get the typed field on `req.storage`. |

### Refine the language with a second middleware

Pick a per-domain default for requests that make no explicit choice: `shop.example.pl` defaults to Polish, `shop.example.de` to German. An explicit `?lang=`, cookie or `x-lang` header still wins.

```ts sample
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { ServerMiddleware, Request } from '@spinajs/http';
import '@spinajs/intl-http';
import * as express from 'express';

const DOMAIN_LANGUAGE: Record<string, string> = {
  'shop.example.pl': 'pl',
  'shop.example.de': 'de',
};

@Injectable(ServerMiddleware)
export class DomainLanguageMiddleware extends ServerMiddleware {
  @Config('intl.queryParameter')
  protected LangQueryParameter!: string;

  constructor() {
    super();

    // After IntHttpMiddleware (1), so this value overwrites its default.
    this.Order = 2;
  }

  public before() {
    return (req: Request, _res: express.Response, next: express.NextFunction) => {
      const name = this.LangQueryParameter;
      const explicit = req.query[name] || req.cookies?.[name] || req.headers[`x-${name}`];
      const domainLanguage = DOMAIN_LANGUAGE[req.hostname];

      if (!explicit && domainLanguage) {
        req.storage.language = domainLanguage;
      }

      next();
    };
  }

  public after() {
    return null;
  }
}
```

### Inject the stored language

`@Lang()` ignores values written by other middlewares. This decorator injects `req.storage.language`, so actions see exactly what templates and `guessLanguage()` see.

```ts sample
import { Injectable } from '@spinajs/di';
import { BasePath, BaseController, Get, Ok, Route, Parameter, RouteArgs, IRouteCall, IRouteParameter, Request } from '@spinajs/http';
import '@spinajs/intl-http';

export function StoredLang() {
  return Route(Parameter('StoredLangArgument'));
}

@Injectable()
export class StoredLangArgument extends RouteArgs {
  public get SupportedType() {
    return 'StoredLangArgument';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request) {
    return { CallData: callData, Args: req.storage.language };
  }
}

@BasePath('catalog')
export class CatalogController extends BaseController {
  // On shop.example.de with DomainLanguageMiddleware: lang === 'de'
  @Get()
  public currentLanguage(@StoredLang() lang: string) {
    return new Ok({ lang });
  }
}
```

### Read the request language in a service

Inside a request, `guessLanguage()` from `@spinajs/intl` returns `req.storage.language`. Outside a request (CLI, queue job) it returns `intl.defaultLocale`, or the language you pass.

```ts sample
import { Autoinject, Injectable } from '@spinajs/di';
import { BasePath, BaseController, Get, Ok } from '@spinajs/http';
import { guessLanguage, __translate } from '@spinajs/intl';
import '@spinajs/intl-http';

@Injectable()
export class InvoiceNotifications {
  public subject(invoiceNumber: string, language?: string) {
    const lang = guessLanguage(language);
    return __translate(lang)('Invoice %s is ready', invoiceNumber);
  }
}

@BasePath('invoices')
export class InvoicesController extends BaseController {
  @Autoinject()
  protected Notifications!: InvoiceNotifications;

  // GET /invoices/preview?lang=pl -> subject from locales/pl.json
  @Get()
  public preview() {
    return new Ok({ subject: this.Notifications.subject('FV/2026/10/17') });
  }
}
```

## Important behaviour

- **Equal `Order` values:** `RealIp` and `RequestId` in `@spinajs/http` also use `Order = 1`. Use `2` or higher to run reliably after `IntHttpMiddleware`.
- **Validation happens once:** only `IntHttpMiddleware` checks the 2 to 5 character rule. A value your middleware writes is not validated; keep it to locales you have translations for.
- **Sorted once:** `HttpServer` sorts middlewares when it resolves. Changing `Order` later has no effect.
- **No storage outside requests:** `req.storage` exists only for HTTP requests. `guessLanguage()` falls back to `intl.defaultLocale` elsewhere.
- **Background work:** a promise started in the action and awaited later keeps the async context, so `guessLanguage()` still sees the request language. A job queued and run by a worker does not; pass the language with the job.

## Best practices

- Refine with a second middleware rather than replacing `IntHttpMiddleware`; the explicit-choice rules and validation stay in one place.
- Re-check the explicit sources (`query`, `cookies`, `x-<name>`) before overwriting, so a user's choice always beats a derived default.
- Store the language in queued job payloads and pass it to `guessLanguage(language)` in the worker.

## Patterns and antipatterns

```ts
// Don't: Order 0 runs before IntHttpMiddleware, which then overwrites the value.
constructor() {
  super();
  this.Order = 0;
}

// Do: run after IntHttpMiddleware.
constructor() {
  super();
  this.Order = 2;
}
```

## Related

- [Request language](01-request-language.md): the middleware these extensions build on.
- [`@Lang()` route argument](02-lang-route-argument.md): the shipped argument and how to replace it.
- [`@spinajs/http`](../http/README.md): `ServerMiddleware`, `RouteArgs`, `Route()` and `Parameter()`.
- [`@spinajs/intl`](../intl/README.md): `guessLanguage()`, `__translate()` and locale files.
- [`@spinajs/di`](../di/README.md): `@Injectable`, `@Autoinject` and lists of implementations.
