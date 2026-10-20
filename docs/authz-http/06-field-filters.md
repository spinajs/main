# Field filters

The field filters limit what an `@Access` route reads and writes to the fields its decision allows. Body input loses the fields the caller may not write (or the request is refused with 400 in `reject` mode), and with `fields: 'filter'` the response keeps only the fields the caller may read. `authz.fields.neverRead` (default `['Password']`) is removed from both, for every caller.

Routes without `@Access` are not filtered: login and password routes carry passwords on purpose.

## How it works

Field sets, `decisionFields(authz, decision, domain)`:

1. Takes `decision.fields.write` and `decision.fields.read`, or `['*']` when the route has no decision (another policy group admitted the request).
2. Subtracts the domain's `fields.neverRead` from both.
3. Reads the domain's write mode, `strip` or `reject`. Both come from the `authz` config merged over the domain's lineage (`authz.domains.<name>.fields` overrides its parent).

Input, `AuthzInputFieldFilter.filter(input, parameter)` (an http `ArgInputFilter`, run on every argument before validation):

1. Skips arguments that are not body input. Body input is the route argument types in `BODY_ARGS`: `FromBody` (`@Body`), `BodyFieldRouteArgs` (`@BodyField`), `FromForm` (`@Form`), `FromFormField` (`@FormField`), `FromCSV` (`@CsvFile`), `FromJSONFile` (`@JsonFile`), `FromXmlRouteArgs` (`@FromXml`) and `AsDbModel` (the ORM model argument).
2. Skips the route when it has neither `req.storage.AuthzHttpRoute` nor `req.storage.AuthzDecision` (no `@Access`), or when it has `@UnfilteredInput(reason)`.
3. **One field.** A primitive value, a parameter declared `String`, `Number`, `BigInt` or `Boolean`, or a list that is empty or holds anything but plain records is one field of the record, checked by the parameter name: `@Body() roles: string[]` needs `roles` to be writable.
4. **A record.** An object, or a non-empty list of plain records, is filtered against the write globs (`filterObject`), nested paths included.
5. In `strip` mode the filtered value goes on (a refused single field becomes `undefined`). In `reject` mode any removed path throws `BadRequest` (400) with `{ error: 'fields_not_writable', fields: [...paths], message: 'fields not writable: ...' }`.

Output, `AuthzFieldsMiddleware.onResponse()` (a route middleware `@Access(..., { fields: 'filter' })` adds):

1. Takes the response data, resolves its promises (a list element-wise).
2. Filters each object to the read set of the route's decision, or to `['*']` minus `neverRead` when another policy group admitted the request.
3. Leaves non-object data (a string, a number) as it is.

The same read filter is available on demand: a client that sends `x-data-transform: authz-fields` gets the JSON body filtered by `AuthzFieldTransformer` on any `@Access` route ([Data transformers](../http/12-data-transformers.md)).

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Access(permission, { fields: 'filter' })` | class or method | `fields: 'filter' \| 'none'` | Adds `AuthzFieldsMiddleware` once to the route or controller: the response keeps `decision.fields.read` minus `neverRead`. |
| `@UnfilteredInput(reason)` | class or method | `reason`: non-empty string (throws at load otherwise) | The body input of the route (or every route of the class) is not filtered. Shows as `x-authz-unfiltered-input` in OpenAPI. |

## Configuration

These are core `authz.*` keys ([`authz.*` config](../authz/04-host-boot-and-configuration.md#configuration)); per domain under `authz.domains.<name>.fields`.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.fields.neverRead` | `string[]` | `['Password']` | field globs | Removed from every read and write set, for every principal. |
| `authz.fields.write.mode` | `string` | `'strip'` | `'strip'`, `'reject'` | `strip`: drop refused body fields silently. `reject`: answer 400 naming them. |

```ts
export default {
  authz: {
    fields: { neverRead: ['Password', 'TotpSecret'], write: { mode: 'reject' } },
  },
};
```

Arrays from several config files are concatenated, so a package can add to `neverRead`, never remove from it.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzInputFieldFilter` | `ArgInputFilter` list, `@Injectable(ArgInputFilter)` | `AuthzInputFieldFilter` | | Remove with `DI.unregister(AuthzInputFieldFilter)`; see [Argument input filters](../http/07-argument-input-filters.md). |
| `AuthzFieldsMiddleware` | route middleware added by `@Access(..., { fields: 'filter' })`; `@NewInstance` | `AuthzFieldsMiddleware` | | Not meant to be replaced. |
| `AuthzFieldTransformer` | `DataTransformer` list, `@Injectable(DataTransformer)`, `Type` `'authz-fields'` | `AuthzFieldTransformer` | | See [Data transformers](../http/12-data-transformers.md). |
| `decisionFields(authz, decision, domain?)` | exported function | | | Call it in your own filters to get `{ read, write, writeMode }` for a decision. |

## Important behaviour

- **Strip is silent.** In `strip` mode a refused field disappears; a required argument that becomes `undefined` then fails validation with 400.
- **A named object argument is matched as a record**, not as `<name>.*`: `@Body() settings: object` with `{ Name }` passes when `Name` is writable. This keeps `neverRead` effective for record DTOs next to other body args. Give such an argument its own route, or check it in the action.
- **A list holding anything but records is one field.** A client cannot turn `['admin']` into a record list by adding `{}`.
- **`neverRead` holds even when another policy group admitted the request.** With no decision the sets are `['*']` minus `neverRead`.
- **The deciding rule's `fields` counts.** A route `@Access` without `fields: 'filter'` turns the class's response filter off for that route.
- **Query, URL, header and cookie arguments are never filtered**: they are not writes.
- **Output filtering needs `fields: 'filter'`** or the client's `x-data-transform: authz-fields`; without either the response is sent as the action built it.

## Best practices

- Put secrets that must never leave the server (password hashes, MFA secrets) in `authz.fields.neverRead`, not in per-role field grants.
- Use `reject` mode for APIs whose clients should learn about refused fields; keep `strip` for forms that send whole records back.
- Put `@UnfilteredInput` on the few admin routes that legitimately write a `neverRead` field, such as an admin setting a user's password, and give a reason.

## Patterns and antipatterns

```ts
// Don't: the response carries every column, whatever the decision allows the caller to read.
@Get(':id')
@Access('employee:read', { resource: fromParam('id', 'employee') })
public get(@Param() id: string) {}

// Do
@Get(':id')
@Access('employee:read', { resource: fromParam('id', 'employee'), fields: 'filter' })
public get(@Param() id: string) {}
```

## Examples

### Hide the salary from managers who may not read it

A model grants `employee:read` with every field to HR and with a field list without `salary` to managers ([`@spinajs/authz`](../authz/01-check-flow.md#concepts)). The same route serves both.

```ts sample
import { Access, UnfilteredInput, fromParam } from '@spinajs/authz-http';
import { BaseController, BasePath, Body, Get, Ok, Param, Patch, Post } from '@spinajs/http';

class EmployeeChangesDto {
  public name?: string;
  public salary?: number;

  constructor(data: Partial<EmployeeChangesDto>) {
    Object.assign(this, data);
  }
}

class NewAccountDto {
  public email!: string;
  public Password!: string;

  constructor(data: Partial<NewAccountDto>) {
    Object.assign(this, data);
  }
}

@BasePath('employees')
export class EmployeesController extends BaseController {
  // Managers get the record without salary.
  @Get(':id')
  @Access('employee:read', { resource: fromParam('id', 'employee'), fields: 'filter' })
  public get(@Param() id: string) {
    return new Ok({ id, name: 'Ada', salary: 9000 });
  }

  // A manager's salary change is stripped (or refused with 400 in reject mode).
  @Patch(':id')
  @Access('employee:update', { resource: fromParam('id', 'employee') })
  public update(@Param() id: string, @Body() changes: EmployeeChangesDto) {
    return new Ok({ id, ...changes });
  }

  // Password is in neverRead; this admin route must receive it.
  @Post(':id/account')
  @Access('employee:create-account', { resource: fromParam('id', 'employee') })
  @UnfilteredInput('the admin sets the first password of the account')
  public createAccount(@Param() id: string, @Body() account: NewAccountDto) {
    return new Ok({ id, email: account.email });
  }
}
```

## Related

- [Protecting routes](01-protecting-routes.md): the decision these filters read.
- [Argument input filters](../http/07-argument-input-filters.md): where the input filter runs.
- [Data transformers](../http/12-data-transformers.md): `x-data-transform: authz-fields`.
- [Policies and access in http-socket](../http-socket/10-policies-and-access.md): `@SocketAccess` runs the same input filter on socket payloads.
- [`@spinajs/authz`](../authz/04-host-boot-and-configuration.md#configuration): `fields.neverRead` and `fields.write.mode`.
