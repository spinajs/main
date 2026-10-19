# `@spinajs/intl-http`

Per-request language for `@spinajs/http`. A server middleware reads the language from the query string, a cookie or an `x-` header and stores it in the request storage, where `@spinajs/intl`, `@spinajs/templates` and `@spinajs/intl-orm` pick it up. The `@Lang()` parameter decorator hands the same language to a controller action.

It does **not** translate anything itself: translations come from `@spinajs/intl`. It does **not** read the `Accept-Language` header, and it does **not** restrict the language to `intl.locales`. It does **not** remember the language between requests: set the cookie yourself (see [Let users switch language](01-request-language.md#let-users-switch-language-and-remember-it)).

## Install

```sh
npm install @spinajs/intl-http
```

Importing the package registers its services. There is no bootstrapper and no config file of its own: it reads `intl.queryParameter` and `intl.defaultLocale` from the `@spinajs/intl` config.

## Features

| Feature | What it does |
| --- | --- |
| [Request language](01-request-language.md) | `IntlHttpMiddleware`: detects the language of every request and stores it in `req.storage.language` for translations, templates and translated models |
| [`@Lang()` route argument](02-lang-route-argument.md) | `@Lang()` and `LangArgument`: inject the request language into an action, optionally limited to a list of allowed languages |
| [Custom language resolution](03-custom-language-resolution.md) | Refine the detected language with an extra middleware, add your own language-like route arguments, read the language in services |

## Extension points

| Service | DI token and lifetime | Default implementation | How to replace or extend |
| --- | --- | --- | --- |
| Language middleware | `ServerMiddleware` list and `IntlHttpMiddleware`, singleton | `IntlHttpMiddleware` | [Replace it](01-request-language.md#intlhttpmiddleware-custom-implementation) or [add a refining middleware](03-custom-language-resolution.md#refine-the-language-with-a-second-middleware) |
| `@Lang()` argument handler | `'LangArgument'` (the class name), singleton | `LangArgument` | [Subclass and register it as `LangArgument`](02-lang-route-argument.md#langargument-custom-implementation) |
| Request storage field | `IActionLocalStoregeContext.language` in `@spinajs/http`, augmented by this package | set by `IntlHttpMiddleware` | [Read or overwrite it](03-custom-language-resolution.md#read-the-request-language-in-a-service) |

## Quick start

`config/intl.js` in your app:

```js
export default {
  intl: {
    defaultLocale: 'en',
    locales: ['en', 'pl'],
    queryParameter: 'lang',
  },
};
```

A controller that answers in the caller's language:

```ts sample
import '@spinajs/intl-http';
import { Lang } from '@spinajs/intl-http';
import { BasePath, BaseController, Get, Ok, TemplateResponse } from '@spinajs/http';

@BasePath('welcome')
export class WelcomeController extends BaseController {
  // GET /welcome/page?lang=pl renders `welcome.pug` with `__()` translating into Polish
  @Get()
  public page() {
    return new TemplateResponse('welcome.pug', { title: 'Welcome' });
  }

  // GET /welcome/language?lang=de answers 400: only English and Polish are served here
  @Get()
  public language(@Lang(['en', 'pl']) lang: string) {
    return new Ok({ lang });
  }
}
```

## Related packages

- [`@spinajs/http`](../http/README.md): the server, `ServerMiddleware`, `RouteArgs` and the request storage this package plugs into.
- [`@spinajs/intl`](../intl/README.md): the translations, the `intl.*` config and `guessLanguage()`, which reads the language stored here.
- [`@spinajs/templates`](../templates/README.md): renders `TemplateResponse` views in the stored language.
- [`@spinajs/di`](../di/README.md): how the services above are registered, replaced and unregistered.
