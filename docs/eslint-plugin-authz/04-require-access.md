# The `require-access` rule

`@spinajs/authz/require-access` reports an http route method that has no `@Access`, `@Policy` or `@AllowAnonymous` on it or on its class. Rule type: `problem`. It reads the syntax tree only, so it needs no type information. It is the edit-time twin of the boot report of `@spinajs/authz-http` ([Unguarded routes](../authz-http/10-access-metadata-and-openapi.md#unguarded-routes)).

**Why it matters.** A route with none of these decorators runs for every caller, anonymous ones included. The rule makes "open on purpose" an explicit `@AllowAnonymous()`.

## How it works

The rule visits every class method (`MethodDefinition`).

1. **Route.** The method needs a route decorator: `@Get`, `@Post`, `@Put`, `@Patch`, `@Del` or `@Head`, written `@Get`, `@Get(...)` or `@ns.Get(...)`, plus the names in `routeDecorators`.
2. **Guard on the method.** `@Access`, `@Policy` or `@AllowAnonymous` (same three forms), plus the names in `guardDecorators`, ends the check.
3. **Guard on the class.** The same decorators on the class declaration or class expression that holds the method end the check.
4. **Report.** Otherwise the method name is reported as `unguardedRoute`, naming `Controller.method`.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `routeDecorators` | `string[]` | `[]` | unique, non-empty names | Decorator names that also mark a method as a route. |
| `guardDecorators` | `string[]` | `[]` | unique, non-empty names | Decorator names that also guard a route, such as your own wrapper around `@Access`. |

```js
rules: { '@spinajs/authz/require-access': ['error', { guardDecorators: ['Authenticated'] }] }
```

## Important behaviour

- **Decorators are matched by name.** A renamed import (`import { Get as Fetch }`) is not seen as a route.
- **A guard on a base class is not seen.** A subclass method with a route decorator and no guard of its own is reported even when its parent class has `@Access`. Repeat the guard, or list the wrapper in `guardDecorators`.
- **`@Unscoped` is no guard.** It needs an `@Access` on the route or class and fails route registration without one.
- **Suppress one route** with `// eslint-disable-next-line @spinajs/authz/require-access`, or better, give it `@AllowAnonymous()`.

## Examples

| Code | Result |
| --- | --- |
| `@Get() @Access('file:read') read() {}` | Not reported. |
| `@Access('file:read') class C { @Get() read() {} }` | Not reported: the class guards every method. |
| `@Get() @Policy(IsAuthenticated) me() {}` | Not reported. |
| `@Get() @AllowAnonymous() health() {}` | Not reported: open on purpose. |
| `@Get() list() {}` | Reported as `C.list`. |
| `@Get() @Unscoped('export') list() {}` | Reported as `C.list`. |
