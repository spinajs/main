# Conditions

A policy's `when` is a JSON condition over the principal, the actor, the resource, the request env and the scope. The language and its compiler live in `@spinajs/authz`; this page describes how `AbacModel` uses them and what each attribute resolves to.

## How it works

1. **At load** `AbacModel` parses `when` with its own `DefaultConditionCompiler`, built from the `functions` option or from every `ConditionFunction` in root DI. A syntax error, an unknown function or a bad literal function argument fails the load with `AuthzConfigError` naming `abac policy "<id>" when`.
2. **On a check** the model compiles the parsed condition with the domain's `ConditionCompiler` (`EvaluationContext.conditions`, a `DefaultConditionCompiler` built from the functions, scope resolvers and adapters along the domain's container lineage).
3. The compiler walks the tree in order:
   - `principal.*`, `actor.*` and `env.*` are read from the request now;
   - `scope.<type>.*` reads the scope attributes of the nearest node of `<type>` among the resource's ancestors;
   - `resource.*` becomes a residual comparison on the row, which the engine decides when the row is given (`subject`) and returns as a conditional decision when not;
   - a function runs with read-only views of the principal, the actor and env.
4. The result is `TRUE`, `FALSE`, a residual, or UNKNOWN (SQL `NULL`), plus flags: `needsSubject`, `cacheable`. [The ABAC model](01-abac-model.md#a-check) turns it into the policy's part of the vote.

## The language

| Node | Form | Meaning |
| --- | --- | --- |
| All | `{ all: [c1, c2] }` | AND. |
| Any | `{ any: [c1, c2] }` | OR. |
| Not | `{ not: c }` | NOT. |
| Comparison | `{ attr: '<path>', <op>: <value> }` | Exactly one operator. A value may be `{ ref: '<path>' }`. |
| Function | `{ fn: '<name>', args: { ... } }` | Calls a registered `ConditionFunction`; an arg may be `{ ref: '<path>' }`. |

| Operator | Value |
| --- | --- |
| `eq`, `ne` | string, number, boolean or `{ ref }`; `null` is refused, use `null`. |
| `in`, `nin` | list of strings and numbers, or `{ ref }`. |
| `lt`, `lte`, `gt`, `gte` | string, number or `{ ref }`. |
| `like` | SQL `LIKE` pattern, case-sensitive: `%` any run, `_` one character, `\` escapes. |
| `glob` | `*` any run without `/`, `**` any run with `/`. |
| `wildcard` | `*` any run, `/` included. |
| `null` | `true`: the attribute is missing or null; `false`: it is present. |

| Path root | Example | Resolved | Notes |
| --- | --- | --- | --- |
| `principal.*` | `principal.attributes.dept`, `principal.authn.assurance` | Now, from `req.principal`. | |
| `actor.*` | `actor.type` | Now, from `req.actor`, else the principal. | |
| `env.*` | `env.ip`, `env.now` | Now, from the request's `env` plus `now`. | Makes the decision uncacheable. |
| `scope.<type>.*` | `scope.org.policies.frozen` | Now, from the attributes of the nearest `<type>` ancestor; `scope.$global.*` from the `$global` node. | Needs a resource id, except `$global`. |
| `resource.*` | `resource.status` | On the row. | Only as `attr` or a function arg; never as a `{ ref }` value. |

Limits: depth 32, 1000 nodes, 10000 values. The segments `__proto__`, `prototype` and `constructor` are refused.

## Configuration

No config keys. The functions a condition may call come from DI and from the `functions` option of [`AbacModel`](01-abac-model.md#configuration).

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Condition function | `ConditionFunction`, class registration per function, read with `Array.chainOf` | `time.between`, `ip.in`, `glob`, `wildcard` (registered when `@spinajs/authz` is imported) | your own | `DI.register(MyFunction).as(ConditionFunction)`, with a name of its own. |

The compiler itself is the core's `DefaultConditionCompiler`, which `@spinajs/authz` registers as a factory under `ConditionCompiler`. The model uses its `compileParsed` when present, else `compile`.

Built-in functions:

| Function | Args | True when |
| --- | --- | --- |
| `time.between` | `{ from: 'HH:MM', to: 'HH:MM', tz? }` | `env.now` is at or after `from` and before `to` on the wall clock of `tz` (IANA zone or offset, default UTC). `from` after `to` wraps past midnight. |
| `ip.in` | `{ cidrs: string[], ip? }` | `ip` (default `env.ip`) lies in one of the ranges. A range with host bits set is refused. |
| `glob` | `{ value, pattern }` | `value` matches like the `glob` operator. |
| `wildcard` | `{ value, pattern }` | `value` matches like the `wildcard` operator. |

### Condition function: custom implementation

Write a function when a rule needs logic the operators do not have. Extend `KleeneConditionFunction` to answer UNKNOWN (`undefined`) instead of guessing, and to check literal args at load. Register it in root DI before the authz domains boot: the model checks function names against root DI at init, and the domain compiler looks along the container lineage.

```ts sample
import { DI } from '@spinajs/di';
import { AuthzConfigError, ConditionFunction, KleeneConditionFunction } from '@spinajs/authz';
import type { ConditionFunctionContext } from '@spinajs/authz';

// { tz?: string }: true from Monday to Friday on the wall clock of tz.
export class BusinessDay extends KleeneConditionFunction {
  readonly name: string = 'time.businessDay';

  override checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    for (const key of Object.keys(args)) {
      if (key !== 'tz') throw new AuthzConfigError(`${where}: time.businessDay takes tz only, not ${JSON.stringify(key)}`);
    }
  }

  evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined {
    const tz = (args as { tz?: unknown } | null)?.tz ?? 'UTC';
    const now = ctx.env.now;
    if (typeof tz !== 'string' || !(now instanceof Date)) return undefined;
    try {
      const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
      return day !== 'Sat' && day !== 'Sun';
    } catch {
      return undefined;
    }
  }
}

DI.register(BusinessDay).as(ConditionFunction);
```

A policy then calls it: `when: { not: { fn: 'time.businessDay', args: { tz: 'Europe/Warsaw' } } }`.

## Important behaviour

- **UNKNOWN fails closed.** A missing attribute makes its comparison UNKNOWN. The engine reads UNKNOWN as "no" in a permit and "yes" in a deny, so a deny on `principal.attributes.dept eq 'ops'` also denies a principal without `dept`.
- **`eq: null` and `ne: null` are refused** at load: they never match. Write `{ attr, null: true }` or `{ attr, null: false }`.
- **Wrong kinds.** A literal of the wrong kind fails the load. A `{ ref }` whose value has the wrong kind (a list for `eq`, a scalar for `in`) is UNKNOWN.
- **`scope.<type>.*` must resolve.** An unknown node, a missing ancestor of the type or a missing attribute throws, and the vote is indeterminate (B39).
- **No row, no answer.** A function arg that reads `resource.*` with no row given, or a `scope.<type>.*` read on a request without id, needs the subject. A deny then denies with `needs_subject` (B19). A permit permits nothing, except one that reads `scope.<type>.*`, which makes the vote indeterminate (B39).
- **Uncacheable reads.** `env.*`, and principal values the decision cache does not key, mark the decision uncacheable.
- **Session reads in summaries.** A permit that is false now but reads `actor.*`, `env.*`, `principal.*` beyond `id`, `type` and `attributes`, or calls a function, is still listed in `summary` and `covers`, as conditional: another session of the principal may meet it.
- **Function results.** A plain `ConditionFunction` that returns no boolean throws, and the vote is indeterminate. A `KleeneConditionFunction` that returns `undefined` gives UNKNOWN.
- **Two functions with one name** fail the compiler; an override of a built-in needs another name.
- **`functions` option and the domain compiler must agree.** The option only drives the checks at load; evaluation always uses the domain compiler's functions.

## Best practices

- Pair a deny on an attribute with a presence test when a missing value must not deny: `{ all: [{ attr: 'principal.attributes.dept', null: false }, { attr: 'principal.attributes.dept', eq: 'ops' }] }`.
- Compare against the principal with `{ ref }` instead of building one policy per user: `{ attr: 'resource.owner_id', eq: { ref: 'principal.id' } }`.
- Keep conditions of `list: true` permissions to `principal.*`, `actor.*`, `env.*` and `scope.$global.*` ([Lists](04-lists.md)).

## Patterns and antipatterns

```ts
// Don't: refused at load, it never matches
when: { attr: 'resource.archived_at', eq: null }

// Do
when: { attr: 'resource.archived_at', null: true }
```

```ts
// Don't: a ref value never points at the resource (no row-to-row comparison)
when: { attr: 'resource.owner_id', eq: { ref: 'resource.created_by' } }

// Do: compare the row with the caller
when: { attr: 'resource.owner_id', eq: { ref: 'principal.id' } }
```

## Examples

### Freeze projects through a scope attribute

A deny reads `scope.project.frozen`, an attribute an admin sets on the project with `scope.setAttributes`. Every resource under a frozen project is read-only.

```ts
authz: {
  abac: {
    policies: [
      { id: 'frozen-projects', effect: 'deny', permissions: ['task:update', 'task:delete'],
        when: { attr: 'scope.project.frozen', eq: true }, reason: 'project_frozen' },
    ],
  },
}
```

A check of `{ type: 'task', id }` reads the task's nearest `project` ancestor. A type-level check (no id) cannot read it and denies `needs_subject`.

## Related

- [The ABAC model](01-abac-model.md): where the compiled condition goes.
- [Policies](02-policies.md): the policy that carries `when`.
- [`@spinajs/authz`](../authz/README.md): the engine and the residual filters.
- [The `authz` connection and records](../authz-orm/03-authz-connection-and-records.md): `DbScopeAttributeStore`, which keeps the scope attributes `scope.<type>.*` reads.
