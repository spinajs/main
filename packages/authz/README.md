# `@spinajs/authz`

Authorization core for SpinaJS: contracts, engine, conditions, host.

## Writing a model

A model is a class that extends `AuthorizationModel` (RBAC, ABAC, ReBAC, or your own). The engine
calls `evaluate(req, ctx)` and combines the votes. These rules keep the answer correct and safe to
cache.

### Missing or failed data

- Throw, or let the call time out. Never vote "no". The engine treats a thrown or timed-out vote as
  indeterminate (`model_error`): it fails closed and is never cached. A "no" vote looks like a clean
  answer, so the engine can cache it.
- Memoise the promise of a load in `ctx.cache`, or memoise nothing. Never write a placeholder value
  before the load settles: a concurrent check reads it as a clean answer the engine cannot see as a
  fault.

### Caches

- Key every cache you keep (your own or `ctx.cache`) on everything the answer depends on: principal
  state, permission, resource, scope, version. A missing part leaks one answer to another request.
- Do not derive a cacheable vote from `principal.identity` or `env`: the L2 key does not hold them.
  Set `cacheable: false` on such a vote. Refs to `env.*` or `identity` in a residual already make the
  decision uncacheable.
- `validUntil` on a vote caps the life of a cached decision: set it for every expiring grant.
- `denies[]` carries one entry per deny source, each with a `reason`. Set `reason.priority` (lower
  wins) so the engine reports the right reason; ties break on `sortKey`.

### Capabilities

`capabilities` is a promise. The engine and the boot checks rely on it.

- `effects`: the vote kinds the model casts (`permit`, `deny`).
- `residuals`: every filter op a vote may hold. An op left out fails boot or is refused at run time.
- `sync`: governs `filterNow` on type-level requests. `after-preload` needs a `preload` method, and
  `filterNow` refuses it until `preload` ran for the principal.
- `fields`: true when votes carry `fields`.
- `needsSubject`: true when some answers need the row and cannot be residualised.
- `principalTypes`, `resourceTypes`: narrow the model to the types it can judge; the engine skips it
  for others.

### Lifecycle

- `init(ctx)` runs once per model instance, in the first domain that lists it. Register permissions,
  native filters and relations there (`ctx.registerPermissions`, `ctx.registerNativeFilter`,
  `ctx.registerRelation`). A child domain sees the registrations of its parent.
- `version()`: when the value changes, the engine recompiles the routes and drops the domain's L2 cache.
- `invalidate(tags)` receives the `AuthzChange` tags from every store: drop your own caches for them.
- `dispose()`: the host calls it once the last domain that lists the model is disposed, and only if
  its `init` ran; DI disposes models that are DI `Service`s itself.

### Registration

- A root model may use `@Injectable(AuthorizationModel)`.
- A child-domain model is registered on the domain's container, never with `@Injectable` (DI-2: a
  decorator registers in root, so the model would leak into every domain):

  ```ts
  const domains = await DI.resolve(AuthzDomains); // needs the Configuration resolved first
  const c = domains.create('fs'); // or domains.create('fs', 'parent')
  // Register before the first domains.service('fs'): a booted domain does not see later registrations.
  c.register(FsModel).as(AuthorizationModel);
  ```

### Testing

- Run `runModelConformance` from `@spinajs/authz-testing` against the model.
- Run the B-rules your lane owns with `runBehaviour` (see the `@spinajs/authz-testing` README, "Writing
  a harness" and "DI rules for harness writers").

## Host

- One `AuthzService` per domain. Resolve the root service with `await DI.resolve(AuthzService)`, any
  domain with `await (await DI.resolve(AuthzDomains)).service(name)`.
- `authz(domain?)` is synchronous and never resolves anything: resolve the service first, or it
  throws `AuthzConfigError`.
- `service.runAs(principal, reason, fn)` runs `fn` with `principal` as the current principal, with
  its own request cache. It audits the call unless `authz.audit.runAs` is false.
- Config lives under `authz.*`. `authz.domains.<name>.*` applies to one domain and its children:
  `combine`, `engine`, `fields`, `cache` and `audit` override the parent's, `permissions` adds to the
  parent's registry, `disable` drops ancestor models by name. A model reads its own
  section, `authz.<model.name>.*`, through `ctx.config(path, default)`.
- A package feeds the boot checks by registering an `AuthzContributor`; its `contribute(domain)`
  returns permission, relation and scope refs, join types and scope attribute schemas.
