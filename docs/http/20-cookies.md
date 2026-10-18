# Cookies

The package parses request cookies with `cookie-parser`, bound to `http.cookie.secret`, reads them into actions with `@Cookie()`, and sets them from responses through `IResponseOptions.Coockies`. Signed cookies are signed and verified with `cookie-signature` and the same secret. Default cookie options from `http.cookie.options` apply to every cookie a response sets.

## How it works

**Parsing.** The default `http.middlewares` contain `configuredCookieParser`. On the first request it reads `http.cookie.secret` from the configuration and builds `cookieParser(secret)` once; later requests reuse it. It fills `req.cookies`, `req.signedCookies` and `req.secret`. Reading the secret on the first request, not at import, lets the app's configuration override the shipped default.

**Reading with `@Cookie(secure)`** (`FromCookie`):

1. With `secure = false`, takes `req.cookies[<parameter name>]`. Missing: `null`.
2. With `secure = true`, takes the value `cookie-parser` verified into `req.signedCookies`. When the cookie is still in `req.cookies` (a parser without a secret, or a cookie signed before the `s:` prefix), it strips an `s:` prefix and verifies the rest with `cookie-signature`'s `unsign()` and `http.cookie.secret`. Missing: `null`. A missing or wrong signature logs a warning and gives `null`.
3. Converts and validates the value like any [route argument](04-route-arguments.md#validation-and-conversion), with the schema `{ type: 'string' }`.

**Setting from a response.** Every response class applies `options.Coockies` before writing the body:

1. Merges `http.cookie.options` with the cookie's own `Options`; the cookie's options win.
2. With `Options.signed: true`, signs the value with `cookie-signature`'s `sign()` and `http.cookie.secret`, then sends it with `signed: false`. The value is `s:<value>.<signature>`, the format Express and `cookie-parser` use.
3. Calls `res.cookie(name, value, options)`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.cookie.secret` | `string` | `'1234adreewD'` | non-empty string | Signs and verifies cookies. The default is public (exported as `HTTP_PUBLIC_COOKIE_SECRET`, tested by `isPublicCookieSecret`): set your own. |
| `http.cookie.options` | `express.CookieOptions` | `{ maxAge: 900000, httpOnly: true }` | | Defaults for every cookie a response sets. `maxAge` is in ms (15 minutes). |

```ts
export default {
  http: {
    cookie: {
      secret: process.env.COOKIE_SECRET,
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 3600 * 1000,
      },
    },
  },
};
```

The `http.configuration` schema refuses an empty `secret`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Cookie(secure = false)` | parameter | `secure`: verify the signature | The cookie named like the parameter; `null` when missing or, with `secure`, badly signed. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `FromCookie` | Route argument, DI name `'FromCookie'`, singleton; reads `http.cookie.secret` in its constructor | `FromCookie` | | Subclass and `DI.register(Mine).as(FromCookie)` before the first request. |
| Cookie parser | An entry of `http.middlewares` | `configuredCookieParser` (not exported) | `cookieParser(secret)` from `cookie-parser` | Replace the `http.middlewares` array; keep a parser built with the same secret. |
| Response cookies | `_setCoockies(res, options)`, exported, called by every response class | | | Call it from your own `Response.execute()` to keep the defaults and signing. |

### `FromCookie`: custom implementation

Rotate the cookie secret without logging everybody out: verify against the current secret, then against the previous ones. `cookie-parser` drops a cookie it cannot verify from `req.cookies`, so the subclass reads the raw value from the `Cookie` header.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FromCookie, IRoute, IRouteCall, IRouteParameter } from '@spinajs/http';
import * as cs from 'cookie-signature';
import * as express from 'express';

export class RotatingFromCookie extends FromCookie {
  public async extract(callData: IRouteCall, args: unknown[], param: IRouteParameter, req: express.Request, res: express.Response, route: IRoute) {
    if (!param.Options?.secure) {
      return super.extract(callData, args, param, req, res, route);
    }

    const pair = (req.headers.cookie ?? '').split(/;\s*/).find((p) => p.startsWith(`${param.Name}=`));
    if (!pair) {
      return { CallData: callData, Args: null };
    }
    const sent = decodeURIComponent(pair.slice(param.Name.length + 1));
    const raw = sent.startsWith('s:') ? sent.slice(2) : sent;

    const cfg = DI.get(Configuration)!;
    const secrets = [cfg.get<string>('http.cookie.secret'), ...cfg.get<string[]>('http.cookie.previousSecrets', [])];

    for (const secret of secrets) {
      const value = cs.unsign(raw, secret);
      if (value !== false) {
        return { CallData: callData, Args: await this.tryHydrateParam(value, param, route) };
      }
    }

    this.Log.warn({ cookie: param.Name }, 'Cookie ${cookie} has no valid signature under any configured secret');
    return { CallData: callData, Args: null };
  }
}

// Before the first request.
DI.register(RotatingFromCookie).as(FromCookie);
```

Responses keep signing with `http.cookie.secret`, so cookies migrate to the new secret as they are set again.

## Important behaviour

- The shipped secret `1234adreewD` is public. Anyone can forge a signed cookie until you set `http.cookie.secret`.
- Cookies signed by responses carry the `s:` prefix, so `cookie-parser` moves them into `req.signedCookies` and removes them from `req.cookies`. Read them with `@Cookie(true)`: with the default parser, `@Cookie()` gives `null` for a signed cookie.
- `@Cookie(true)` still accepts a cookie signed without the `s:` prefix, as responses signed them before, so sessions and other signed cookies already issued keep working.
- `FromCookie` reads the secret once, when it is first resolved; changing the configuration later does not change it. `configuredCookieParser` likewise builds its parser on the first request.
- `@Cookie()` reads the cookie named like the parameter; there is no option for another name.
- `http.cookie.options` apply to every response cookie, including ones set by other packages through `IResponseOptions`; `maxAge` 15 minutes is the default lifetime of all of them.
- Replacing `http.middlewares` without a cookie parser leaves `req.cookies` undefined and breaks `@Cookie()`.

## Best practices

- Set `http.cookie.secret` from a secret store in every environment, and `secure: true` in `http.cookie.options` behind HTTPS.
- Sign every cookie whose value the server trusts (`Options.signed: true`) and read it with `@Cookie(true)`.
- Keep cookie values small identifiers; store data on the server.

## Patterns and antipatterns

```ts
// Don't: an unsigned cookie the server trusts — the client can set any value.
@Get('cart')
public cart(@Cookie() cartOwner: string) { /* ... */ }

// Do
@Get('cart')
public cart(@Cookie(true) cartOwner: string) { /* null when tampered with */ }
```

## Examples

### Remember the chosen theme in a signed cookie

```ts sample
import { BaseController, BasePath, Cookie, Get, Ok, Param, Post } from '@spinajs/http';

@BasePath('preferences')
export class PreferencesController extends BaseController {
  /** POST /preferences/theme/dark */
  @Post('theme/:theme')
  public setTheme(@Param({ type: 'string', enum: ['light', 'dark'] }) theme: string) {
    return new Ok(
      { theme },
      {
        Coockies: [{ Name: 'theme', Value: theme, Options: { signed: true, maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' } }],
      },
    );
  }

  /** GET /preferences/theme → "dark", or "light" when missing or tampered with */
  @Get('theme')
  public theme(@Cookie(true) theme: string | null) {
    return new Ok({ theme: theme ?? 'light' });
  }
}
```

## Related

- [Responses](10-responses.md): `IResponseOptions`.
- [Route arguments](04-route-arguments.md): `@Cookie()` among the other decorators.
- [HTTP server](01-http-server.md#configuration): the default `http.middlewares`.
- `@spinajs/authn-http`: session cookies built on this secret.
