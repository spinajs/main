# `@Lang()` route argument

`@Lang()` injects the request language into a controller action parameter. Pass a list of languages to refuse every other one with `400 Bad Request`. Use it when the action itself needs the language, eg. to pick a document version or to store a user preference.

## How it works

1. `@Lang(allowedLanguages?)` calls `Route(Parameter('LangArgument', null, { allowedLanguages }))`. The route parameter gets `Type = 'LangArgument'` and `Options = { allowedLanguages }`.
2. On each call `extractRouteArgs()` in `@spinajs/http` resolves the handler with `DI.resolve('LangArgument')`, by name. Handlers run by `Priority`, higher first; `LangArgument` has none, so it counts as `0`.
3. `LangArgument.extract()` reads the request again, with the same rules as the middleware: query `?<name>=`, then cookie `<name>`, then header `x-<name>`, where `<name>` is `intl.queryParameter`. It does **not** read `req.storage.language`.
4. No value: the parameter receives `intl.defaultLocale`. The allow-list is not checked.
5. A value: it must be a string of 2 to 5 characters, else `InvalidArgument`. With an allow-list, a value outside it throws `InvalidArgument('Language not supported, allowed languages are en,pl')`. `@spinajs/http` maps both to `400`.
6. The value is passed to the action parameter.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Lang(allowedLanguages?: string[])` | Controller action parameter, typed `string` | `allowedLanguages`: the languages the action accepts; omitted means any 2 to 5 character string | Injects the request language, or `intl.defaultLocale` when the request names none. Answers `400` for an invalid or disallowed value. |

`@Lang()` combines with any other parameter decorator on the same action (`@Query()`, `@Body()`, ...). It needs no `@spinajs/validation` schema: `LangArgument` does its own checks and skips the schema step.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `intl.queryParameter` | `string` | `'lang'` | lower-case name | Query parameter, cookie and `x-<name>` header read by `LangArgument`. |
| `intl.defaultLocale` | `string` | `'en'` | a locale code | Value injected when the request names no language. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `@Lang()` argument handler | `@Injectable()` registers it under its class name `'LangArgument'`; singleton (no lifetime decorator). Resolved lazily with `DI.resolve('LangArgument')` the first time a route with `@Lang()` is called. | `LangArgument` (extends `RouteArgs` from `@spinajs/http`) | none shipped | Replace: `DI.register(MyArgument).as(LangArgument)`, last registration wins. Extend: subclass it and override `extract()`, call `super.extract()` for the default rules, set `Priority` to run before or after other arguments. |

Members a subclass uses:

| Member | Kind | Meaning |
| --- | --- | --- |
| `SupportedType` | getter, `'LangArgument'` | Parameter type this handler serves. Keep it when you replace the handler. |
| `extract(callData, args, param, req)` | method | Returns `{ CallData, Args }`; `Args` is the value passed to the action. |
| `LangQueryParameter` | protected, `@Config('intl.queryParameter')` | Name looked up in query, cookies and `x-` header. |
| `defaultLocale` | protected, `@Config('intl.defaultLocale')` | Fallback value. |
| `Priority` | public, optional number | Order among the action's argument handlers, higher first. |
| `param.Options.allowedLanguages` | `string[] \| undefined` | The list given to `@Lang()`. |

### LangArgument: custom implementation

Replace the handler when every `@Lang()` parameter needs different rules. This one honours `Accept-Language` when the request names no language, and never injects a language outside the allow-list.

- Register it at startup, before the server handles requests: the first resolve caches the singleton.
- Every existing `@Lang()` parameter uses it; controllers do not change.

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { BasePath, BaseController, Get, Ok, IRouteCall, IRouteParameter, Request } from '@spinajs/http';
import { Lang, LangArgument } from '@spinajs/intl-http';

@Injectable()
export class AcceptLanguageArgument extends LangArgument {
  public async extract(callData: IRouteCall, args: unknown[], param: IRouteParameter<{ allowedLanguages?: string[] }>, req: Request) {
    const name = this.LangQueryParameter;
    const explicit = req.query[name] || req.cookies?.[name] || req.headers[`x-${name}`];

    if (explicit) {
      return super.extract(callData, args, param, req);
    }

    const allowed = param.Options?.allowedLanguages;
    const best = allowed ? req.acceptsLanguages(...allowed) : false;

    return { CallData: callData, Args: best || allowed?.[0] || this.defaultLocale };
  }
}

// `@Lang()` resolves 'LangArgument' by name; the last registration under that name wins.
DI.register(AcceptLanguageArgument).as(LangArgument);

@BasePath('documents')
export class TermsController extends BaseController {
  // A browser sending `Accept-Language: de-DE,de;q=0.9,en;q=0.8` gets the English terms.
  @Get()
  public terms(@Lang(['en', 'pl']) lang: string) {
    return new Ok({ url: `/static/terms.${lang}.pdf` });
  }
}
```

## Important behaviour

- **Default ignores the allow-list:** with `intl.defaultLocale = 'pl'` and `@Lang(['en', 'de'])`, a request with no language injects `'pl'`. Check the value in the action, or use a custom handler as above.
- **Independent of the middleware:** `LangArgument` re-reads the request. A language written to `req.storage.language` by another middleware does not reach `@Lang()`; see [Custom language resolution](03-custom-language-resolution.md#inject-the-stored-language).
- **Case-sensitive allow-list:** `?lang=EN` fails `@Lang(['en'])` with `400`.
- **Same input limits as the middleware:** 2 to 5 characters, one value, plain cookie only. See [Request language](01-request-language.md#important-behaviour).
- **Unregistered handler:** when `'LangArgument'` resolves to nothing, the call fails with `UnexpectedServerError` ("Route parameter not registered"). Importing `@spinajs/intl-http` registers it.

## Best practices

- List the languages you have content for in `@Lang([...])`; unlisted languages answer `400` instead of serving a fallback silently.
- Keep `intl.defaultLocale` inside every allow-list you use, or the default request gets a language the action does not support.
- Use `@Lang()` only when the action needs the value. For translating output, `guessLanguage()` and templates already have it.

## Patterns and antipatterns

```ts
// Don't: parse the language by hand. It skips the cookie and the x-lang header, and the 2-5 character check.
@Get()
public terms(@Query() lang: string) {
  return new Ok({ url: `/static/terms.${lang ?? 'en'}.pdf` });
}

// Do
@Get()
public terms(@Lang(['en', 'pl']) lang: string) {
  return new Ok({ url: `/static/terms.${lang}.pdf` });
}
```

## Examples

### Serve a localized document and refuse unknown languages

```ts sample
import '@spinajs/intl-http';
import { Lang } from '@spinajs/intl-http';
import { BasePath, BaseController, Get, Ok } from '@spinajs/http';

const PRIVACY_POLICY: Record<string, string> = {
  en: 'We store your e-mail address to send you invoices.',
  pl: 'Przechowujemy Twój adres e-mail, aby wysyłać Ci faktury.',
};

@BasePath('legal')
export class LegalController extends BaseController {
  // GET /legal/privacy?lang=pl    -> 200, Polish text
  // GET /legal/privacy            -> 200, text in intl.defaultLocale
  // GET /legal/privacy?lang=de    -> 400, "Language not supported, allowed languages are en,pl"
  // GET /legal/privacy?lang=german -> 400, value longer than 5 characters
  @Get()
  public privacy(@Lang(['en', 'pl']) lang: string) {
    return new Ok({ lang, text: PRIVACY_POLICY[lang] ?? PRIVACY_POLICY.en });
  }
}
```

## Related

- [Request language](01-request-language.md): the middleware that stores the same language for templates and services.
- [Custom language resolution](03-custom-language-resolution.md): your own argument types next to `@Lang()`.
- [`@spinajs/http`](../http/README.md): `RouteArgs`, `Parameter()`, `Route()` and argument `Priority`.
- [`@spinajs/di`](../di/README.md): registering a class `.as()` another and resolving by name.
