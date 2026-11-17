# Authz flow findings (AUTHZ001, AUTHZ002, AUTHZ006)

While it builds a package's fragment, `@spinajs/compiler` follows every entry point of the package through the code it calls and looks for queries of access-resource models that run without `.accessible(permission)`. What it finds goes into the fragment's `authz.findings`; how much of the code it could follow goes into `authz.flow` ([Authorization facts](../manifest/README.md#authorization-facts)).

## Why

`@spinajs/authz-orm` never filters a query on its own: a select without `.accessible()` returns every matching row. The [`require-accessible`](../eslint-plugin-authz/02-require-accessible.md) lint rule catches that in one file. It cannot see a query that a service builds and a helper runs. The fixture of this pass has one:

```ts
// controllers.ts
@Get('overdue')
@Access('invoice:read')
public async overdue(@Query() days: number) {
  return new Ok(await this.Invoices.overdue(days));
}

// services.ts
public async overdue(days: number) {
  const q = Invoice.where('Status', 'open');   // line 13
  return this.withAge(q, days);
}

private withAge(q: ISelectQueryBuilder<Invoice[]>, days: number) {
  return q.where('DueAt', '<', new Date(Date.now() - days * 86_400_000));
}
```

The route checks `invoice:read` for the caller, then reads every open invoice of every tenant. Each file looks fine on its own. The pass reports, at `src/services.ts:13`:

```text
AUTHZ001 route GET /invoices/overdue reaches an unscoped multi-row read of access resource 'invoice' (Invoice); path: InvoicesController.overdue -> InvoiceService.overdue (injected), and 1 more entry point
```

The other entry point is a queue job that reaches the same line through `DI.resolve(InvoiceService).overdue(3)`.

## Codes

One finding per query site and code (and per `runAs` site). Its message names the first entry point, in the order of `authz.entryPoints`, that reaches the site, the call path from that entry point's handler, and how many more entry points reach it. Each hop of the path says how the call was resolved when it is not a plain call: `injected` (an `@Autoinject` property), `resolve` (`DI.resolve(T)`), `implementation` (an abstract or interface member) or `reference` (a function passed by name). Findings are sorted by file, line, column and code.

| Code | Reported when | Message |
| --- | --- | --- |
| `AUTHZ001` | An entry point reaches a multi-row read of an access-resource model with no scope | `<entry> reaches an unscoped multi-row read of access resource '<type>' (<Model>); path: <path>` |
| `AUTHZ002` | An entry point reaches an `update` or `delete` builder of an access-resource model with no scope | `<entry> reaches an unscoped update of access resource '<type>' (<Model>); path: <path>` (or `delete`) |
| `AUTHZ006` | An entry point reaches `runAs(SYSTEM, reason, fn)` whose reason is not a string literal | `<entry> runs as SYSTEM with no literal reason; path: <path>` |

`<entry>` is the entry point as the doctor names it: `route GET /invoices/overdue`, `socket command chat.send`, `queue handler job:SendMail`, `schedule nightly`, `CLI command users:import`.

A single-row read (`first()`, `get`) is not reported: the route's own check covers the row, as `require-accessible` assumes. A static model member that is no read of rows (`insert`, `count`, `exists`, `truncate`) is recorded in the pass's summaries with its scope and not reported, so a create route gets no warning.

All three are **warnings** in 4.x and become errors in 5.0. A finding never fails a build or a boot: it is data in the fragment, and nothing reads it at runtime.

## Entry points

The pass starts at the function each entry point of `authz.entryPoints` runs:

- a route, a socket command or a socket event: its handler method, an inherited one included;
- a queue job, a schedule or a CLI command: `execute` of its class;
- a consumed event (`event:<Class>`): the function passed to `consume(Event, handler)`, written inline or by name.

## What the pass follows

- A call or a `new` whose callee has a body in the package's own source files, and the overrides of that method in the package's subclasses.
- An abstract member or an interface method, to every class of the package that extends or implements its owner or names it in `@Injectable(Token)`.
- `this.<prop>.method()` where the property is `@Autoinject` / `@Inject`, and `DI.resolve(T).method()`.
- A getter read.
- A function of the package passed by name (`ids.map(this.remove)`), and the receiver of `f.call(...)`, `f.apply(...)` or `f.bind(...)`: each counts as called.
- Functions written inline (callbacks, closures), analysed where they stand with the builders of the enclosing function in scope.

Language built-ins (`Promise.all`, `Array.prototype.map`) are neither followed nor counted: they run only what they are handed, and what they are handed is covered by the rules below.

## What it does not follow, and counts

In the code an entry point reaches, no call and no builder is silently safe. What the pass cannot follow is counted in `authz.flow`:

| Counter | What it counts |
| --- | --- |
| `entryPoints` | Entry points whose handler the pass analysed. |
| `unresolvedRoots` | Entry points whose handler has no body in the package (inherited from a dependency) or cannot be located. |
| `opaqueCalls` | Calls whose callee the program does not determine: a callback parameter, a function held in a property or variable, an abstract member nothing implements, an overloaded function, an untyped callee. Also a function value handed on that the program does not determine (`ids.map(visit)` with `visit` a parameter), and a function whose summary still changes after 20 rounds. |
| `externalCalls` | Calls into a dependency's declaration files (other packages, Node's own modules). A dependency's fragment has findings for its own entry points only, so a dependency service the app calls is analysed nowhere. A call to a dependency's abstract token that the package implements is counted here too, and the package's implementation is not used. |
| `foreignModelQueries` | Unscoped query sites of a model class another package declares. Decorators do not survive into declaration files, so the pass cannot tell whether that model is an access resource. |

## When a builder counts as executed

- It is awaited, returned from an `async` function, returned as a promise, or called with an executing member (`first`, `all`, `then` and the rest of the set `require-accessible` uses). A static read that returns a promise at once (`Model.find(pks)`) is the same.
- It leaves what the pass can follow: it is passed to a callee the pass does not follow (`Promise.all([q1, q2])`, `new Ok(q)`), put into an array or object literal that is returned, assigned to a property or an element, or returned by a function written inline. Such a builder may never run; then silence the finding with an ignore comment.
- A builder passed to a followed callee is judged by the callee: it is not executed when the callee neither runs nor returns it. A parameter not typed as a builder (`any`, a type parameter, `PromiseLike`) hides what the callee does with it, so there the builder counts as executed at the call.
- What an entry point's handler returns, the framework runs: a builder returned by a handler that is not `async` is executed there.

A builder the pass cannot trace to a model class (a property, a variable of an enclosing scope, the result of a call into a dependency or of a callee without a summary) is read from its type: a pending builder of the model the type names, made where the expression stands. A choice (`c ? q1 : q2`, `a ?? b`) is scoped only when every operand is.

What a static model member starts is read from what it returns: a builder gives its kind (`where`, `all`, `query`: select; `update`: update; `destroy`: delete), a promise of rows a select (`find`, `first`, `get`), anything else is no read of rows.

## Scope

- `.accessible(...)` scopes the builder, in its chain or by a statement (`q.accessible(p);`) on a variable that is never reassigned.
- `.unscoped(reason)` scopes it as deliberately unscoped: not reported.
- Inside the callback of `runAs(SYSTEM, reason, fn)` every query, also those of the functions it calls, runs as SYSTEM and is not reported. `runAs` must be the one `@spinajs/authz` declares and `SYSTEM` the one `@spinajs/principal` declares (`@spinajs/authz` re-exports it), so an app's own function called `runAs` exempts nothing. Without a literal reason the call is `AUTHZ006`.
- `runAs(otherPrincipal, ...)` changes nothing.

## What the pass does not see

- Code no entry point reaches: policies, route middlewares, model hooks, the `resolve()` of an injected service, field initialisers of a class without a constructor of its own.
- Writes through a model instance (`invoice.update()`, `invoice.destroy()`) and raw driver queries: they have no builder of a model.
- Control flow inside one body. `.accessible()` applied on one branch or in a loop counts as applied for the rest of the body, when nothing writes the variable after its declaration. A closure scopes only the builders it declares.
- A builder put into an array or object held in a variable before it leaves.
- A value typed only as the ORM's base `QueryBuilder` (or `IQueryBuilder`, `IBuilder`, `IWhereBuilder`). It has no kind and no model, so it is not reported. The pass knows the six select, update and delete builder types of `@spinajs/orm`.
- Getters declared in a dependency and setters. A property read typed as a builder is still read from its type.
- `PromiseLike` and other structural stand-ins for a builder. A class that matches an interface only by its shape (no `implements`, no `@Injectable(Token)`) is not a target of a call through that interface.

Two places where a finding is reported somewhere else than you may expect:

- A parameter with a default is reported where the default stands when the default runs, and at the call when a caller passes the argument.
- When a function is also passed by name in code the pass reaches, an unscoped builder a direct caller hands it, and that the function runs, is reported at the function's use of the parameter, not at the caller's argument. An ignore comment there silences the direct callers too.

Noise on purpose (reported, though it may be safe):

- A builder returned in an object shorthand (`return { q }`), and a closure that is also summarised as a callee of its own: both are read from their types.
- Every builder member of a union is an effect of its own: the pass's summaries hold one effect per kind and model. The findings stay one per code and site, and the message names the first.

## Ignoring a finding

Put a comment on the line of the query (or of the `runAs` call), or on the line above it:

```ts
// spinajs-authz-ignore AUTHZ001: admin report across all tenants
const rows = await Invoice.where('Status', 'paid');
```

The reason after the colon is required. The comment is recorded in `authz.ignores`; the finding stays in the fragment, and the doctor drops it from its report.

## In `spinajs doctor`

Three doctor rules report the findings, one per code: `AUTHZ001` (`flowUnscopedRead`), `AUTHZ002` (`flowUnscopedWrite`) and `AUTHZ006` (`flowSystemWithoutReason`), all warnings ([doctor](doctor.md#rules)). They read `authz.findings` of the app manifest and report the findings of the app's own package only: a dependency's fragment carries findings for its own entry points, and they are its maintainers' to fix. An ignore comment silences its code at its own line and the line below, nothing else; the silenced finding stays in the manifest.

`spinajs doctor --fail-on warning` makes the findings fail a CI run.

## Relation to `require-accessible`

Lint is the fast path: it runs in the editor and sees one file. The compiler follows calls across files, injected services, overrides and `DI.resolve`, at build time. Keep both.
