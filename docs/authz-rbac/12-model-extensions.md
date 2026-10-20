# Model extensions

An `RbacExtension` hooks into the RBAC model outside its nine steps: model init, extra role edges, the boot compile, the gathering phase, boot refs and native filter ops. Ladders, implied roles, subject sets, rules and token roles are all extensions; you can add your own, for example to read assignments that live in another system.

## How it works

1. Without `extensions`, `RbacModel` builds one instance from each factory of `DEFAULT_RBAC_EXTENSIONS`: `ladderExtension`, `impliesExtension`, `setsExtension`, `rulesExtension` (`createRbacExtensions(options)`).
2. `RegisterRbacOptions.extensions` (or `RbacModelOptions.extensions`) replaces that list. The model always appends `tokenRoleExtension` last, and drops any copy of it you pass.
3. The model calls the hooks in list order:

| Hook | When | Use |
| --- | --- | --- |
| `init(ctx)` | `RbacModel.init`, before the roles compile | Read config through `ctx.config`, resolve services. |
| `extraEdges(defs, ladders)` | Every role compile | Role edges beside `extends`; they count for cycles and closures. |
| `compile(graph, grants, registry)` | After the grant index is built, at boot through the contributor | Validate; throw `AuthzConfigError` to fail the boot. |
| `tables(graph, grants)` | Every gather | Give the `ladders` or `implies` table; memoise per graph. Two extensions giving one table throw. |
| `gather(request, ctx, input, sources)` | End of every gathering phase | Return a `Partial<RbacInput>` merged into the input (subjects, assignments, rules). Return a value, not a promise, to keep votes synchronous. |
| `contribute(graph, grants)` | `RbacContributor.contribute` | Extra boot refs (`permissionRefs`, `relationRefs`, `scopeRefs`). |
| `residuals`, `nativeFilters()` | Model construction, `init` | Filter ops the steps emit; each `native:*` op needs its `NativeFilter`. |
| `capabilities` | Model construction | `needsSubject: true` when the extension needs the row. |

The nine steps themselves (`RBAC_STEPS`) are not replaceable on `RbacModel`; `runRbacPipeline(input, steps)` and `rbacState(input, through, steps)` take a custom step map for tools and tests.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Extensions | `RbacModelOptions.extensions`; not DI; one list per model | `createRbacExtensions(options)` over `DEFAULT_RBAC_EXTENSIONS`, then `tokenRoleExtension` | your own `RbacExtension` objects or classes | `registerRbac(container, configuration, { extensions: (o) => [...createRbacExtensions(o), mine] })`. |

Exports for extension authors: `RbacExtension`, `RbacExtensionFactory`, `RbacInput`, `RbacSources`, `RbacState`, `LiveAssignment`, `RBAC_STEP_NAMES`, `RBAC_STEPS`, `readRbacInput`, `runRbacPipeline`, `liveAssignments`, `resourcePath`, and the shipped classes `LadderExtension`, `ImpliesExtension`, `SetsExtension`, `RulesExtension`.

### `RbacExtension`: on-call role from a schedule

An on-call engineer holds `oncall` at `$global` while the schedule says so. The assignment lives in the schedule, not in `authz_assignment`.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { GLOBAL } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext } from '@spinajs/authz';
import { createRbacExtensions, registerRbac } from '@spinajs/authz-rbac';
import type { RbacExtension, RbacInput } from '@spinajs/authz-rbac';

// Kept fresh by a schedule poller; the gather must not do IO to keep votes synchronous.
const onCallNow = new Set<string>(['user:17']);

const onCallExtension: RbacExtension = {
  gather(_request: DecisionRequest, _ctx: EvaluationContext, input: RbacInput): Partial<RbacInput> {
    const p = input.request.principal;
    if (!onCallNow.has(`${p.type}:${p.id}`)) return {};
    return {
      assignments: [...input.assignments, { id: `oncall:${p.id}`, subject: { type: p.type, id: p.id }, role: 'oncall', scope: GLOBAL, source: 'schedule' }],
    };
  },
};

export async function wireRbacWithOnCall(): Promise<void> {
  const configuration = await DI.resolve(Configuration);
  await registerRbac(DI.RootContainer, configuration, {
    extensions: (options) => [...createRbacExtensions(options), onCallExtension],
  });
}
```

`collect` treats the added row like a stored one: it must name a defined, assignable role allowed at `$global`, and it passes `ceiling.roles`. The engine's decision cache does not know the schedule, so publish an invalidate (`authz().invalidate(['subject:user:17'])`) when the schedule changes.

## Important behaviour

- **Order matters.** A gather sees what earlier gathers added. Put an extension that adds assignments before `setsExtension` when those assignments should make the principal a set member.
- **Tables only through `tables`.** A gather that sets `ladders` or `implies` throws, because `RbacService.covers` reads the tables without gathering.
- **Per model state.** Factories build one instance per model; an extension object shared between models shares its state.
- **Token roles stay last.** The model always runs `tokenRoleExtension` after yours, so an extension cannot add roles past a token's narrowing.

## Related

- [How a check resolves](05-check-resolution.md): the gathering phase and the steps.
- [Token roles](10-token-roles.md): the extension the model always adds.
- [Custom stores](11-custom-stores.md): replace a store instead when the data has a home of its own.
