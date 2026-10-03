# RBAC field filtering on model deserialization

Goal: when a request body is deserialized into an ORM model, drop (or reject) the
fields the caller's role is not granted for that resource + action, using the
attribute lists already declared in rbac grants (`'update:own': ['*', '!Owner']`).

## Current state

- **Grants already carry attributes.** Grants are stored in `accesscontrol`, which
  supports glob attribute lists (`['*', '!Password', 'Address.*']`) and exposes
  `Permission.filter(data)` / `AccessControl.filter(data, attrs)`.
- **Only two things read attributes today:**
  - `RbacModelPermissionMiddleware.policiesFor()` ([packages/rbac/src/middleware.ts:265](../../packages/rbac/src/middleware.ts#L265))
    reads the `scope:<name>` tokens to pick an `OrmPermissionPolicy`.
  - `RoleGuard` in rbac-http-admin compares attribute sets for role delegation.
- **Nothing filters fields.** `FilterAttribute` ([packages/rbac-http/src/middlewares/AttributeFilter.ts](../../packages/rbac-http/src/middlewares/AttributeFilter.ts))
  is an empty stub and nothing references it. `UserDataTransformer` hardcodes
  `delete Password`.
- **Deserialization path for models:**
  `RouteArgs.tryHydrateParam()` ([packages/http/src/route-args/RouteArgs.ts:57](../../packages/http/src/route-args/RouteArgs.ts#L57))
  validates the raw input against the schema, then calls the `custom:arg_hydrator`
  registered on the type. orm-http registers `DbModelHydrator` on every model, and it
  calls `new Model().hydrate(input)`. `AsDbModel`/`@AsModel()` and plain `@Body() m: Model`
  both go through this path. `http-socket` has a copy of the same logic (`interfaces.ts:182`).
- **Paths that bypass it:** orm-api `Update`/`updateRelation` take `@BodyField() data: unknown`
  and call `entity.hydrate(data)` directly. The same applies to any app code that
  hydrates from `req.body` by hand.
- **Request context is available.** Route args are extracted inside
  `storage.run(req.storage, ...)` ([packages/http/src/route-builder.ts:250](../../packages/http/src/route-builder.ts#L250)),
  and the policy gate (and so `RbacPolicy`) runs before them. `RbacPolicy` knows the
  route resource and its permission list, but it discards which permission granted access.
- **Dependency direction:** orm-http depends on http + orm, not rbac. rbac-http depends on
  http + orm + rbac, not orm-http. Both depend on `@spinajs/http`.

`ModelBase.hydrate()` / `ModelHydrator` cannot be used as the hook. The same hydrators
fill models loaded from the DB, and filtering there would corrupt reads.

## Design

### 1. `@spinajs/rbac`: attribute resolution (pure, no HTTP)

In `permission-service.ts`, next to `probeGrant`:

```ts
/** Field attributes granted to `roles` for `action` on `resource`, with `scope:` tokens removed.
 *  null = not granted. A grant carrying only scope tokens means all fields. */
export function grantedFieldAttributes(roles: string[], action: PermissionType, resource: string): string[] | null;

/** Union of the granted attributes across `actions` (a route may list several). */
export function filterByGrant<T>(data: T, roles: string[], actions: PermissionType[], resource: string): { data: Partial<T>; removed: string[] };
```

- Remove the `scope:` tokens before filtering. The PrimeSpot config grants
  `['scope:polsat']` with no `*`, and `accesscontrol.filter` would otherwise remove
  every field.
- Collect the attributes from every granted action the route lists, then run
  `AccessControl.filter` once. A role that only gets in through `updateOwn` still gets
  that grant's fields.
- `removed` = the top-level (and dotted nested) keys present in the input but missing
  from the output. `reject` mode and logging need this.
- Arrays: filter each element. Grants use dot-notation, so nested relation payloads
  (`'!Owner.*'`) are covered too.

### 2. `@spinajs/rbac-http`: record the granted route permissions

In `RbacPolicy.execute`, after the `some(...granted)` check, store the result on the
request storage (new optional field on `IRbacAsyncStorage`):

```ts
RouteGrant?: { Resource: string; Actions: PermissionType[] }   // only the actions that were granted
```

The value is computed on the server from the route declaration, never from the request.
This keeps it in line with the `PermissionScope` security note in the same file.

### 3. `@spinajs/http`: input filter hook

Add an abstract class to http. orm-http and rbac-http both depend on http, so neither
has to import the other:

```ts
export abstract class ArgInputFilter {
  /** Returns the input to hydrate. May throw (eg. Forbidden) to reject it. */
  public abstract filter(input: unknown, parameter: IRouteParameter, route: IRoute): unknown | Promise<unknown>;
}
```

`RouteArgs.tryHydrateParam` resolves `Array.ofType(ArgInputFilter)` and applies the filters
to non-primitive args **before validation** (see D4), for both hydrated and plain object
params. Make the same change in http-socket's copy. When no filter is registered, the
behaviour is unchanged.

### 4. `@spinajs/rbac-http`: `RbacModelInputFilter`

`@Injectable(ArgInputFilter)`. For each arg:

1. Get the model type: `param.RuntimeType`, or `TypedArray.Type`. If it has no
   `extractModelDescriptor(...)?.RbacResource`, pass the input through.
2. Read `RouteGrant` + `User` / `ActiveRole` from the ALS store. With no `RouteGrant`,
   RbacPolicy did not run on this route. Pass the input through (D3).
3. Use the model's `RbacResource` as the resource (D2). Use `RouteGrant.Actions`, with
   roles from `effectiveRoles(user, storage)`.
4. Call `filterByGrant`. Behaviour depends on the mode (D1): `strip` returns the filtered
   data and logs `removed` at trace level; `reject` throws `Forbidden` listing `removed`
   when it is non-empty.
5. Opt-out: `@AsModel({ rbacFilter: false })` / a param option, for internal or admin
   routes that need raw input.

### 5. Paths that bypass the hook

- orm-api `Update.update` / `updateRelation` / `Create`: call `filterByGrant` explicitly
  on `data`, with the model's resource and the route's `updateAny` / `createAny`.
- Export a helper `filterInputForRequest(model, data)` from rbac-http for app code that
  hydrates by hand. It reads the ALS store the same way as step 4.

### 6. Cleanup

Delete the dead `FilterAttribute` stub. Response-side (read) filtering is a separate
feature and can reuse `filterByGrant` later.

## Decisions (recommended default first)

- **D1 Forbidden field present:** `strip` (accesscontrol semantics, idempotent for
  clients that send back the whole object they read) with config
  `rbac.fieldFilter.mode: 'strip' | 'reject'`. `reject` gives 403 and makes client bugs
  visible, but breaks "PUT the object back" flows.
- **D2 Resource source:** the model's `@OrmResource` name, because the field names belong
  to the model. The route `@Resource` can name a different resource (e.g. a controller
  over a view or a DTO).
- **D3 No `RouteGrant` in context (route without RbacPolicy):** pass through (fail open).
  Fail-closed would break every unguarded route that hydrates models. Offer config
  `rbac.fieldFilter.requireGrant: true` for strict apps.
- **D4 Order vs validation:** filter **before** validation. If a role cannot write a
  required field, validation fails with 400 instead of a DB error. Validation first would
  also reject forbidden-but-invalid input with a misleading message.
- **D5 Scope-only grants (`['scope:polsat']`):** all fields. This matches how the grants
  are written today. Mixing `['*', '!X', 'scope:polsat']` also works because the tokens
  are removed.
- **D6 Primary key in body:** PK fields go through the same filter. `FromModel` loads by
  URL param, so a grant `['*', '!Id']` blocks changes to the PK through the body.

## Tests

rbac (unit, no HTTP):
- `grantedFieldAttributes`: `*`, negations, scope-only, scope mixed with `*`, not granted
  gives null, union across two roles.
- `filterByGrant`: nested dot-notation, arrays, `removed` list, multi-action union.

rbac-http (integration, sqlite + test controller):
- `@AsModel() m: Model` on a route with `@Permission(['updateOwn'])`, grant `['*', '!Owner']`,
  and `Owner` in the body: the model has no `Owner` (strip) / 403 (reject).
- The same route with a role granted `['*']` keeps the field.
- `TypedArray` of models: each element is filtered.
- A route without RbacPolicy: the input is unchanged.
- ActiveRole narrowing: the filter uses the active role's grant, not the union of all roles.
- A model without `@OrmResource`: the input is unchanged.
- A forbidden field that is required by the schema: 400 from validation.

orm-api: `PUT :model/:id` with a forbidden field in the body: the stored row keeps
its old value.

http-socket: one test that shows the filter runs on socket arg hydration.

## Rollout

1. rbac: resolver + tests.
2. http: `ArgInputFilter` hook + http-socket copy (no-op without registrations).
3. rbac-http: `RouteGrant` in RbacPolicy, `RbacModelInputFilter`, config, tests.
4. orm-api explicit calls.
5. Publish, bump in yourscreen-backend. Every backend grant is `['*']` or scope-only, so
   the default `strip` mode does not change behaviour until a grant adds `!Field`.
   Verify with the full backend suite after the bump.
