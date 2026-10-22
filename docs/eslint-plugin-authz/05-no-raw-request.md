# The `no-raw-request` rule

`@spinajs/authz/no-raw-request` reports an http controller that reads its input past route-argument validation: a `@Req()` or `@Res()` parameter, or a call to `bodyField()`. Rule type: `problem`. It reads the syntax tree only, so it needs no type information. It is not in `configs.recommended`.

**Why it matters.** Route arguments (`@Body`, `@Query`, `@Param`, `@Header`, `@Cookie` and the typed arg decorators) are validated against their schema before the action runs. An action that takes the raw request reads input no schema checked, so a missing cap or an unknown field goes through unnoticed.

## How it works

1. **Controller.** A class is a controller when it extends a class whose name ends in `Controller` (`BaseController`, `http.BaseController`, a subclass of your own), or when one of its methods has a route decorator (`@Get`, `@Post`, `@Put`, `@Patch`, `@Del`, `@Head`).
2. **Raw parameter.** Every method parameter of a controller decorated with `@Req` or `@Res` (written `@Req`, `@Req()` or `@ns.Req()`), plus the names in `decorators`, is reported as `rawRequestArg`, naming `Controller.method`.
3. **Raw body read.** Every call to `bodyField(...)` or `x.bodyField(...)`, plus the names in `functions`, anywhere inside a controller class, nested functions included, is reported as `rawBodyRead`.

Helpers outside a controller class, route middlewares and policies are not checked.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `decorators` | `string[]` | `[]` | unique, non-empty names | Parameter decorator names refused next to `Req` and `Res`. |
| `functions` | `string[]` | `[]` | unique, non-empty names | Function names whose calls are refused inside a controller, next to `bodyField`. |

```js
rules: { '@spinajs/authz/no-raw-request': ['error', { functions: ['readBody'] }] }
```

## In this repository

The root `eslint.config.mjs` turns the rule on for `packages/{authn,authz}*/src/**/*.ts`. One route keeps `@Req()`, with a disable comment that names the reason:

| Route | Why it takes the request |
| --- | --- |
| `POST /auth/logout` (`AuthnLoginController.logout`, `@spinajs/authn-http`) | The `AuthnLogoutExtension` API takes the request; `@spinajs/authn-oidc` reads the origin from it. |

## Important behaviour

- **Decorators and functions are matched by name.** A renamed import (`import { Req as Request }`) is not seen.
- **Suppress one parameter** with a reason: `// eslint-disable-next-line @spinajs/authz/no-raw-request -- <why>`. Prefer a typed arg decorator (`@ClientContext()`, `@CurrentPrincipal()`, `@AccessDomain()`) that hands the action the one value it needs.

## Examples

| Code | Result |
| --- | --- |
| `@Post() login(@Body() body: LoginDto) {}` | Not reported. |
| `@Get() summary(@CurrentPrincipal() p: Principal) {}` | Not reported. |
| `@Get() read(@Req() req: Request) {}` | Reported as `C.read`. |
| `@Post() login() { return bodyField(this.req, 'login'); }` | Reported as a raw body read in `C`. |
| `class Helper { read(@Req() req: Request) {} }` | Not reported: no controller. |
