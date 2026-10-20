# Custom route arguments

A route argument is a `RouteArgs` class plus a parameter decorator that names it. Write one when an action needs a value the built-in decorators do not provide: the tenant from a header, the current user, a language, a model loaded from the database. Replace a built-in one when it should behave differently everywhere.

## How it works

1. Your decorator calls `Route(Parameter('TenantIdArg', schema?, options?))`. The string is the DI name of the handler; it is stored as the parameter's `Type`.
2. Your handler class extends `RouteArgs` and is registered with `@Injectable()`, which registers it under its **class name**. The class name must equal the string in step 1.
3. Per request, `extractRouteArgs()` calls `DI.resolve('TenantIdArg')` once, sorts all parameters by `Priority` (highest first, default `0`), and calls `extract(callData, callArgs, param, req, res, route)`.
4. `extract()` returns `{ CallData, Args }`. `Args` becomes the action argument. `CallData` is handed to the next handler; keep the incoming one unless you add to its `Payload`.
5. Inside `extract()`, call `this.tryHydrateParam(value, param, route)` to get the standard filter, required check, conversion, validation and hydration; see [Route arguments](04-route-arguments.md#validation-and-conversion). Call `this.filterInput(value, param, route)` for the input filters alone.

The `SupportedType` getter is abstract and should return the same name; the lookup itself uses the decorator's string.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `Route(callback)` | used inside your decorator | `(descriptor, route, target, propertyKey, index) => void` | Gives access to the route being declared. |
| `Parameter(type, schema?, options?)` | used inside `Route()` | `type`: DI name of your handler; `schema`: JSON schema; `options`: anything, read as `param.Options` | Records the parameter on the route. Reads the runtime type from `design:paramtypes`. |
| `@Type(type)` | parameter | class or `Array.ofType(X)` | Sets `param.RuntimeType` when TypeScript cannot. |

`Parameter()` throws when used on anything but a method parameter.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RouteArgs` (abstract) | The handler's class name (string key); `@Injectable()` makes it a singleton; `@NewInstance()` builds one per request | one class per `ParameterType` (see [Route arguments](04-route-arguments.md#parameter-types)) | `LangArgument` (`@spinajs/intl-http`), `FromDbModel`, `AsDbModel`, `FilterModelRouteArg` (`@spinajs/orm-http`), `CurrentUserArg` (`@spinajs/users-http`), `CurrentPrincipalArg` (`@spinajs/authz-http`) | New argument: a class and a decorator. Replace a built-in: subclass it and `DI.register(Mine).as(FromQuery)` before the first request. |
| `IRouteArgs` | interface | | | The shape `extractRouteArgs()` calls: `SupportedType`, `Priority?`, `extract()`. |

Members you use or override:

| Member | Meaning |
| --- | --- |
| `get SupportedType(): ParameterType \| string` | Abstract. Return the DI name. |
| `Priority?: number` | Higher runs earlier in the request. `FromFile` uses 9999. |
| `extract(callData, callArgs, param, req, res, route?)` | Abstract. Returns `Promise<IRouteArgsResult>`. `callArgs` holds the arguments extracted so far, by index. |
| `tryHydrateParam(arg, param, route)` | Protected. Filter, required check, conversion, validation, hydration. |
| `filterInput(arg, param, route?)` | Protected. Runs the `ArgInputFilter` chain only. |
| `Validator` | Protected, autoinjected `DataValidator`. |

### A new route argument: custom implementation

The handler is a singleton shared by all requests: keep request data in local variables, never in fields, unless the class is `@NewInstance()`.

```ts sample
import { Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, IRoute, IRouteArgsResult, IRouteCall, IRouteParameter, Ok, Parameter, Request, Route, RouteArgs } from '@spinajs/http';
import * as express from 'express';

export interface ITenantIdOptions {
  header: string;
  allowed?: string[];
}

/** Tenant id from a header, validated against a slug schema and an optional allow-list. */
export function TenantId(options: ITenantIdOptions = { header: 'x-tenant-id' }) {
  return Route(Parameter('TenantIdArg', { type: 'string', pattern: '^[a-z0-9-]{2,32}$' }, options));
}

@Injectable()
export class TenantIdArg extends RouteArgs {
  public get SupportedType(): string {
    return 'TenantIdArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<ITenantIdOptions>, req: Request, _res: express.Response, route?: IRoute): Promise<IRouteArgsResult> {
    const options = param.Options ?? { header: 'x-tenant-id' };
    const raw = req.headers[options.header.toLowerCase()];

    // Required check, schema validation and the input filters.
    const tenant = (await this.tryHydrateParam(raw, { ...param, Options: { required: true } }, route!)) as string;

    if (options.allowed && !options.allowed.includes(tenant)) {
      throw new Forbidden(`tenant ${tenant} is not served by this endpoint`);
    }

    return { CallData: callData, Args: tenant };
  }
}

@BasePath('invoices')
export class InvoicesController extends BaseController {
  /** GET /invoices   x-tenant-id: acme */
  @Get('/')
  public list(@TenantId() tenant: string) {
    return new Ok({ tenant, items: [] });
  }

  /** GET /invoices/eu   x-org: acme-eu */
  @Get('eu')
  public eu(@TenantId({ header: 'x-org', allowed: ['acme-eu', 'globex-eu'] }) tenant: string) {
    return new Ok({ tenant });
  }
}
```

The handler module must be imported before the first request; importing the decorator from the same file is enough.

### Replacing a built-in route argument

Subclass the built-in and register the subclass under the built-in's class. Every `@Query()` in the app then uses your class. Register before the first request: the built-in is cached as a singleton once it resolves.

```ts sample
import { DI } from '@spinajs/di';
import { FromQuery, IRoute, IRouteParameter } from '@spinajs/http';

/** Trims every string query value and turns an empty one into "absent". */
export class TrimmingFromQuery extends FromQuery {
  protected async tryHydrateParam(arg: any, param: IRouteParameter, route: IRoute) {
    if (typeof arg === 'string') {
      const trimmed = arg.trim();
      arg = trimmed === '' ? undefined : trimmed;
    }

    // Filters, required check, conversion and validation as usual.
    return super.tryHydrateParam(arg, param, route);
  }
}

// DI.resolve('FromQuery') now returns TrimmingFromQuery.
DI.register(TrimmingFromQuery).as(FromQuery);
```

## Important behaviour

- The lookup is by name. Two packages that both register a handler class named `CurrentUserArg` collide: the last registration wins. Prefix the class name with your package.
- `Priority` sorts all parameters of the route, not only yours. A handler that reads what another handler stored in `callData.Payload` needs a lower `Priority` than that handler.
- `FromQuery`, `FromParams` and the form handlers keep the incoming `Payload` and add their own entry (`Query.Args`, `Param.Args`, `Form`); `Query.Args` and `Param.Args` collect the values of every `@Query()` and `@Param()` that ran before. Do the same in your handler.
- A handler that throws stops the request; the exception goes to the [error handler](11-error-handling.md). Throw `BadRequest`, `Forbidden` or `ValidationFailed` to get 400 or 403.
- `tryHydrateParam()` expects `param.Name` to be set; it is set at startup from the controller cache.
- `Array.ofType` lists drop `@NewInstance()` registrations, but route argument handlers are resolved one by one by name, so `@NewInstance()` handlers work.

## Best practices

- Name the class and the decorator string identically, and return the same string from `SupportedType`.
- Reuse `tryHydrateParam()` so your argument gets schemas, hydrators and input filters for free.
- Make the handler `@NewInstance()` when it keeps state across `extract()` calls of one request, as the multipart handlers do.

## Patterns and antipatterns

```ts
// Don't: a field on a singleton handler is shared by concurrent requests.
@Injectable()
export class TenantIdArg extends RouteArgs {
  protected Tenant: string;
  public async extract(callData: IRouteCall, _a: unknown[], _p: IRouteParameter, req: Request) {
    this.Tenant = req.headers['x-tenant-id'] as string;
    return { CallData: callData, Args: this.Tenant };
  }
}

// Do: keep request data local.
@Injectable()
export class TenantIdArg extends RouteArgs {
  public async extract(callData: IRouteCall, _a: unknown[], _p: IRouteParameter, req: Request) {
    const tenant = req.headers['x-tenant-id'] as string;
    return { CallData: callData, Args: tenant };
  }
}
```

## Examples

### The signed-in principal from request storage

A middleware earlier in the stack puts the principal on `req.storage`; the argument hands it to the action and refuses anonymous calls.

```ts sample
import { Injectable } from '@spinajs/di';
import { AuthenticationFailed } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, IRouteArgsResult, IRouteCall, IRouteParameter, Ok, Parameter, Request, Route, RouteArgs } from '@spinajs/http';

export interface IApiPrincipal {
  id: string;
  scopes: string[];
}

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    apiPrincipal?: IApiPrincipal;
  }
}

export function ApiPrincipal() {
  return Route(Parameter('ApiPrincipalArg'));
}

@Injectable()
export class ApiPrincipalArg extends RouteArgs {
  public get SupportedType(): string {
    return 'ApiPrincipalArg';
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    const principal = req.storage?.apiPrincipal;
    if (!principal) {
      throw new AuthenticationFailed('this route needs an API key');
    }
    return { CallData: callData, Args: principal };
  }
}

@BasePath('me')
export class MeController extends BaseController {
  @Get('/')
  public me(@ApiPrincipal() principal: IApiPrincipal) {
    return new Ok({ id: principal.id, scopes: principal.scopes });
  }
}
```

## Related

- [Route arguments](04-route-arguments.md): the built-in handlers and the conversion rules.
- [Argument hydrators](06-argument-hydrators.md): build objects from raw values without a new decorator.
- [Request storage and tracing](19-request-storage-and-tracing.md): extending `IActionLocalStoregeContext`.
- [`@spinajs/intl-http`](../intl-http/README.md), [`@spinajs/orm-http`](../orm-http/README.md): shipped custom route arguments.
