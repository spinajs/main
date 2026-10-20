# Conditions

A condition is a JSON tree that says when something applies: an ABAC policy's `when`, an RBAC rule's `when`, a rule's subject selector. The core owns the language, its parser and its compiler, so every model reads conditions the same way. Facts known at check time are decided at once; facts about the row become a residual filter.

## The language

| Node | Example | Meaning |
| --- | --- | --- |
| `{ all: [...] }` | `{ all: [a, b] }` | AND. |
| `{ any: [...] }` | `{ any: [a, b] }` | OR. |
| `{ not: c }` | `{ not: { attr: 'principal.authn.assurance', eq: 'aal2' } }` | NOT. |
| `{ attr, <op>: value }` | `{ attr: 'resource.status', eq: 'draft' }` | One comparison; exactly one operator per node. |
| `{ fn, args? }` | `{ fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } }` | A named function. |

`attr` paths start with a root:

| Root | Reads | When |
| --- | --- | --- |
| `principal.*` | the principal: `principal.attributes.dept`, `principal.authn.assurance` | at check time |
| `actor.*` | the acting principal (`req.actor`, else the principal) | at check time |
| `env.*` | request facts: `env.now` (always set, from `AuthzClock`), whatever the caller passes in `env` (`env.ip`) | at check time |
| `scope.<type>.*` | attributes of the nearest `<type>` ancestor of the resource; `scope.$global.*` of `GLOBAL` | at check time, once the ancestors are known |
| `resource.*` | a field of the row | on the row: a residual `cmp` |

A value is a literal or `{ ref: '<path>' }` to `principal.*`, `actor.*`, `env.*` or `scope.*`. A value never refers to `resource.*`: a row-to-row comparison has no residual form.

| Operator | Value | Matches |
| --- | --- | --- |
| `eq`, `ne` | string, number, boolean, ref | equality; `eq: null` and `ne: null` are refused, use `null` |
| `in`, `nin` | list of strings or numbers, ref | membership |
| `lt`, `lte`, `gt`, `gte` | string or number, ref | order; booleans are refused |
| `like` | string, ref | SQL `LIKE`, case-sensitive: `%` any run, `_` one character, `\` escapes |
| `glob` | string, ref | `*` stops at `/`, `**` crosses it |
| `wildcard` | string, ref | `*` is any run, `/` included |
| `null` | `true` or `false` | the attribute is missing or null (`true`), or present (`false`) |

### Functions

| Name | Args | True when |
| --- | --- | --- |
| `time.between` | `{ from: 'HH:MM', to: 'HH:MM', tz?: '<IANA zone>' }` | `env.now` lies in `[from, to)` in `tz` (default `UTC`). `from > to` wraps midnight; `from = to` is refused. |
| `ip.in` | `{ cidrs: string[], ip?: string }` | `ip` (default `env.ip`) lies in one of the ranges. A range with host bits set or a zone id is refused. IPv4 and IPv4-mapped IPv6 match each other. |
| `glob` | `{ value, pattern }` | as the `glob` operator |
| `wildcard` | `{ value, pattern }` | as the `wildcard` operator |

Any arg may be a `{ ref }`. Literal args are checked when the condition is parsed, so a typo fails boot or the admin write, not the check.

## How it works

1. **Parse.** `parseCondition(input, { functions, where })` copies the input (plain JSON only, no cycles), validates it against `CONDITION_SCHEMA` (AJV), checks the ref grammar and the function names, and caps its size: depth 32 (`MAX_CONDITION_DEPTH`), 1000 nodes (`MAX_CONDITION_NODES`), 10000 values (`MAX_CONDITION_VALUES`). It throws `AuthzConfigError` naming `where` and the path inside the condition.
2. **Compile.** At check time a model calls `ctx.conditions.compile(condition, req, ctx)`. `DefaultConditionCompiler`, registered by importing `@spinajs/authz`, binds every `principal.*`, `actor.*`, `env.*` and `scope.*` read to its value and decides those comparisons and functions at once.
3. **Residual.** A `resource.*` comparison becomes a `cmp` residual on the row. It is decided at once instead when the request has an id and no subject, its type has a `ScopeResolver` and no adapter, and the resolver's attributes hold the field.
4. **UNKNOWN.** Logic is three-valued (Kleene). A comparison with a missing value, a value of the wrong kind or a function that cannot decide is UNKNOWN (`CONDITION_UNKNOWN` in the residual). The engine binds it to `FALSE` or `TRUE` by its polarity in the final allow, so it fails closed.
5. **Result.** `compile` answers `{ filter, cacheable, needsSubject }`. An `env.*` read, or a read of an uncacheable principal path, makes it `cacheable: false`. `needsSubject` is true when only the row can decide.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ConditionCompiler` | `ConditionCompiler`, a factory: built per domain from the functions, scope resolvers and adapters of its lineage | `DefaultConditionCompiler` | none shipped | Rarely replaced; add functions instead. Without any registration the engine falls back to a compiler that refuses every condition. |
| `ConditionFunction` | `ConditionFunction`, every registration of the container chain | `TimeBetween`, `IpIn`, `GlobMatch`, `WildcardMatch` (`BUILTIN_CONDITION_FUNCTIONS`) | your own | Extend `KleeneConditionFunction` (or `ConditionFunction`) and `DI.register(MyFn).as(ConditionFunction)` before the domain boots. A name may not repeat a built-in's. |

### `ConditionFunction`: custom implementation

Extend `KleeneConditionFunction` so the function can answer UNKNOWN (`undefined`) instead of guessing. `checkArgs` (optional) refuses bad literal args when the condition is parsed.

```ts sample
import { DI } from '@spinajs/di';
import { AuthzConfigError, ConditionFunction, KleeneConditionFunction } from '@spinajs/authz';
import type { ConditionFunctionContext } from '@spinajs/authz';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `{ fn: 'weekday.in', args: { days: ['mon', 'tue'] } }`: today (UTC) is one of the days. */
export class WeekdayIn extends KleeneConditionFunction {
  readonly name = 'weekday.in';

  checkArgs(args: Readonly<Record<string, unknown>>, where: string): void {
    const days = args.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => DAYS.includes(String(d)))) {
      throw new AuthzConfigError(`${where}: weekday.in days must be a non-empty list of ${DAYS.join(', ')}`);
    }
  }

  evaluateKleene(args: unknown, ctx: ConditionFunctionContext): boolean | undefined {
    const days = (args as { days?: unknown }).days;
    const now = ctx.env.now;
    if (!Array.isArray(days) || !(now instanceof Date)) return undefined;
    return days.includes(DAYS[now.getUTCDay()]);
  }
}

DI.register(WeekdayIn).as(ConditionFunction);
```

An ABAC policy then uses it: `when: { not: { fn: 'weekday.in', args: { days: ['sat', 'sun'] } } }`.

## Important behaviour

- **A missing attribute fails closed.** A deny on `principal.attributes.dept eq 'ops'` also denies a principal with no `dept`, because UNKNOWN binds against the allow. To deny only ops, add `{ attr: 'principal.attributes.dept', null: false }` next to it.
- **`scope.*` refs that resolve missing make the vote indeterminate** (B39): an unknown node, no ancestor of the type, an absent attribute. On a type-level request only `scope.$global.*` resolves; the rest needs the row (B19).
- **`resource.*` keeps lists honest.** A permission declared `list: true` cannot be granted by a condition that reads `resource.*`: boot rule 12 and the admin write refuse it.
- **Functions come from the domain's container.** A condition may call every `ConditionFunction` the domain's container sees: its own registrations and those of its ancestors, root included (`registeredFunctions(container)`; the built-ins when it sees none). ABAC policies and RBAC rule conditions are checked the same way. A function registered only in a child domain is unknown in the root.
- **Functions see read-only views.** A function cannot change the principal or `env`; reading an uncacheable path through them makes the decision uncacheable.
- **Function caches are bounded.** `ip.in` keeps at most 256 parsed range lists; `time.between` caches zone formatters.

## Patterns and antipatterns

```ts
// Don't: eq null is refused when the condition is parsed
{ attr: 'principal.attributes.dept', eq: null }

// Do: test presence with the null operator
{ attr: 'principal.attributes.dept', null: true }
```

## Related

- [`@spinajs/authz-abac`](../authz-abac/README.md): policies with `when` conditions.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): rules and subject selectors with `when` conditions.
- [Resource adapters and resolvers](09-adapters-and-resolvers.md#scope-attributes): where `scope.<type>.*` values come from.
