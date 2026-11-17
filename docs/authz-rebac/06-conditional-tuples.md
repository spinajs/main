# Conditional tuples

A conditional tuple holds only while its **caveat** holds: `doc:d1#viewer@user:bob` *from the office network*, or `doc:d2#parent@folder:f1` *until the end of the month*. This is OpenFGA's conditional relationship tuple. The caveat is a named condition declared next to the namespaces; the tuple names it and may fix some of its parameters.

## When to use a caveat, and when ABAC

A caveat reads only the request: `env.*` (the request env, `env.now` being the evaluation instant) and `principal.*`. It never reads the row. Use one when a grant depends on *how* or *when* the principal asks (network, time window, a principal attribute), and the condition belongs to the grant, not to the resource.

Conditions on row attributes (`resource.status`, an owner column) belong to ABAC (`@spinajs/authz-abac`): they need the row, and list plans render them as SQL. Keeping caveats away from the row is what keeps ReBAC list plans exact: every caveat is decided once per request, before rows are read.

## How it works

### Declaring caveats

```ts
authz: {
  rebac: {
    caveats: {
      office_ip: { params: { 'env.ip': 'string', 'env.allowed': 'list<string>' }, expr: { attr: 'env.ip', in: { ref: 'env.allowed' } } },
      not_expired: { params: { 'env.now': 'timestamp', 'env.until': 'timestamp' }, expr: { attr: 'env.now', lt: { ref: 'env.until' } } },
    },
    namespaces: {
      group: { relations: { member: ['user'] } },
      folder: { relations: { viewer: ['user'] }, permissions: { view: 'viewer' } },
      doc: {
        relations: { viewer: ['user', 'user with office_ip', 'group#member with office_ip'], parent: ['folder', 'folder with not_expired'] },
        permissions: { read: { union: ['viewer', 'parent->view'] } },
      },
    },
    permissions: { 'doc:read': 'doc#read' },
  },
}
```

- `expr` is a core `Condition`, the same JSON ABAC uses. `params` maps each **parameter path** the expression reads to its type: `string`, `int`, `double`, `bool`, `timestamp`, `ipaddress`, `list<string>`.
- A path starts with `env.` or `principal.`. `init` refuses `resource.*`, `actor.*` and `scope.*`, an undeclared path in the expression, a type mismatch (`IR004` from `validateCaveats`), and a relation that names an undeclared caveat.
- `'user with office_ip'` admits `user` subjects only with that caveat; plain `'user'` admits them without one. A relation may list both. The shapes are the ones of [Namespaces](02-namespaces.md#shape) with ` with <caveat>` appended.
- A store must keep caveats (`TupleStore.caveats`, true for `MemoryTupleStore` and `DbTupleStore`); `init` refuses conditional subject types over one that does not, which would hold them unconditionally.

### The tuple context

```ts
const share = {
  object: { type: 'doc', id: 'd2' },
  relation: 'parent',
  subject: { type: 'folder', id: 'f1' },
  caveat: { name: 'not_expired', context: { 'env.until': '2026-12-31T00:00:00Z' } },
};
```

The context gives values for some parameters, keyed by path. It **wins** over the request: a request cannot widen an allowlist or move an expiry the tuple fixes. A context that names no parameter of the caveat, has a value of the wrong type or sets `env.now` is refused (`invalid_caveat_context`); a context longer than 4096 characters as JSON is refused too. A context never changes who asks: `principal.type`, `id`, `authenticated` and `source` stay the request's.

The caveat is not part of the tuple's identity: one `object#relation@subject` holds at most one caveat. Writing it again with another caveat is a conflict (see [Tuple stores](03-tuple-stores.md#conditional-tuples)).

### Three-valued answers

A caveat is `allow`, `deny` or `unknown`. A value missing from both the context and the request, an unknown caveat or a failing expression is `unknown`. The walk ANDs the caveat into the tuple's branch with Kleene logic, as the IR reference evaluator does:

| Walk result | Vote |
| --- | --- |
| a branch holds | permit (`cacheable: false` when a caveat read env) |
| no branch holds | no-permit, reason `no_access` |
| no branch holds, some only because a caveat was `unknown` | no-permit, reason `{ code: 'caveat_unknown', model, caveats: [names] }` |
| `maxDepth` cut | the existing error vote |

`caveat_unknown` is a definite no-permit, not an error vote: a missing `env.ip` must not veto other models' permits. `voteTruth` in `@spinajs/authz-testing` reads it as the IR's `unknown`.

`RebacModel.check(object, name, principal, ctx, { env, principal? })` evaluates caveats when given an evaluation context and a request; without them a conditional path is `unknown`.

### Caching, lists and row-level security

- A vote whose walk read env through a caveat is `cacheable: false`. A type-level residual that can reach a caveat is not cacheable and carries the request values of the caveats' parameters (`caveatInput`); when one of those caveats calls a condition function, which may read env and principal beyond its parameters (`ip.in` reads `env.ip`), it carries the whole request env and principal (`caveatRequest`), so each row is decided as the check would decide it. `listSubjects` without a principal leaves such caveats undecided.
- A list plan evaluates each distinct `(caveat, context)` once and keeps the conditional tuples whose caveat is `allow`; `unknown` and `deny` keep none. Such a plan is valid until the evaluation instant, so it is never reused ([Lists](04-lists.md#conditional-tuples)).
- Row-level security has no request to read: a permission that reaches a conditional relation is refused (`AUTHZ020`, or a `TRUE` policy under `rls: 'partial'`), and a conditional membership gives no session key.
- `expand` does not evaluate caveats; it labels conditional leaves. `listSubjects` and the `tuples.subjects` query evaluate them when given an `env`, and return holders under an undecided caveat as `conditional`.

### OpenFGA and scenario files

`rebacToIR` puts conditional subject types and the caveats into the IR, and `writeOpenFga` writes them in OpenFGA's spelling:

```text
type doc
  relations
    define viewer: [user, user with office_ip, group#member with office_ip]

# spina:caveat office_ip {"expr":{"attr":"env.ip","in":{"ref":"env.allowed"}},"params":{"env.allowed":"list<string>","env.ip":"string"}}
condition office_ip(env_ip: string, env_allowed: list<string>) {
  env_ip in env_allowed
}
```

OpenFGA parameters are identifiers, so a path becomes `env_ip`. The `# spina:caveat` comment carries the definition `readOpenFga` restores; a `condition` without it is refused, since the IR does not read CEL. A condition with no CEL form (a condition function) is exported as the comment alone, with a warning (an error under `--strict`), and its subject types keep `with`.

`irToRebacConfig` and `spinajs authz:import` keep conditional subject types and write the caveats to `authz.rebac.caveats`. They never keep a subject type without its caveat: a caveat ReBAC cannot hold (a `resource.*` parameter) or one the model does not define drops every subject type that uses it, and a permission that subtracts such a narrowed relation is dropped too, each with a problem (`--strict` refuses).

In `.fga.yaml` scenarios, tuple condition contexts and check or list contexts use the OpenFGA parameter names and are mapped to paths through the model's conditions:

```yaml
tuples:
  - { user: folder:f1, relation: parent, object: doc:d3, condition: { name: not_expired, context: { env_until: 20 } } }
tests:
  - check:
      - { user: user:dora, object: doc:d3, context: { env_day: 10 }, assertions: { read: true } }
```

A name that is no parameter of a condition, and a condition the model does not define, fail the read. `.authz.yaml` files keep path-keyed contexts.

## Examples

### An IP allowlist per share

```ts
// tuple.write through AuthzAdmin
{ kind: 'tuple.write', tuple: { object: { type: 'doc', id: 'd1' }, relation: 'viewer', subject: { type: 'user', id: 'bob' }, caveat: { name: 'office_ip', context: { 'env.allowed': ['10.0.0.1', '10.0.0.2'] } } } }

const read = (env?: Record<string, unknown>) => authz().check({ principal: bob, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, env });
await read({ ip: '10.0.0.1' }); // allowed
await read({ ip: '10.9.9.9' }); // denied: the ReBAC vote is no_access
await read();                   // denied: the ReBAC vote is caveat_unknown
```

### A time-bound share

The `not_expired` tuple above lets folder `f1`'s viewers read `d2` until the end of 2026. `env.now` is the evaluation instant; nobody can set it, neither the request nor the tuple. After the instant passes, checks deny and list plans drop the row on their next evaluation.

## See also

- [Namespaces](02-namespaces.md)
- [Tuple administration](05-tuple-administration.md#conditional-tuples)
