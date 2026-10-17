# Policies and `@SocketAccess`

Socket commands and events are guarded the way http routes are. `@SocketPolicy` runs the same `BasePolicy` classes through http's own policy gate. `@SocketAccess` checks authz-v3 permissions, as authz-http's `@Access` does, and can filter the payload's writable fields and the result's readable fields.

## How it works

1. `@SocketPolicy`, `@SocketPolicyGroup` and `@SocketAccess` add policy groups to the controller or to one handler.
2. `SocketHandlerRegistry.build()` resolves each member with `container.resolve(Type, Options)`; a string member is first read from the configuration as a policy class name.
3. `PoliciesStage` (order 600) for a command, and the event path before its handler, call `SocketPolicyGate.check(ctx)`. It builds an `ISocketPolicyRequest` and runs http's `createPolicyGate()`:
   - policies whose `isEnabled(route, controller)` is `false` drop out; a group left empty is dropped, not passed;
   - all members of a group must pass (AND), one group of a scope is enough (OR), the controller scope and the handler scope must both pass (AND);
   - a scope with no enabled group passes;
   - a refusal reports the first failure of the first scope that did not hold. A policy that rejects with `undefined` answers `Forbidden('access denied by policy')`.
4. `SocketAccessPolicy` decides a `@SocketAccess` group:
   1. the handler's own rule, else the class rule, marks the call for authz-http's input field filter (`storage.AuthzHttpRoute`) and becomes the deciding rule;
   2. a principal that is not authenticated answers `unauthenticated`, unless `allowAnonymous`;
   3. the `resource` extractor runs; finding nothing answers `invalid_argument`. Without one, the type-level ref of each permission's resource is used (`doc:read` checks `{ type: 'doc' }`);
   4. each permission is checked with `AuthzService.check()` in the rule's `domain`; the first allow wins. With `subject: 'load'`, a conditional allow is checked again against the row the domain's `ResourceAdapter` loads; a missing row is denied with `unknown_resource`;
   5. a denial throws `AccessDenied` (answered `forbidden` with `permission`, `resource` and `reason`); the deciding rule's allow is stored in `storage.AuthzDecision`.
5. `ArgumentsStage` runs the `ArgInputFilter`s; with `@spinajs/authz-http` loaded, the payload loses the fields the decision does not let the caller write.
6. `AccessFieldsStage` (order 650), for a rule with `fields: 'filter'`, limits the result, or each stream chunk, to `decision.fields.read` minus the domain's `fields.neverRead`.

`ISocketPolicyRequest`, what a policy receives in place of the express request:

| Field | Value |
| --- | --- |
| `method` | `'SOCKET'` |
| `originalUrl`, `url` | the full command or event name |
| `headers`, `cookies`, `ip` | from the handshake; `ip` is the [client address](08-principal-sources.md#client-address) |
| `body` | the payload |
| `params` | the payload's own fields when it is a non-array object, else `{}` |
| `query` | `{}` |
| `storage` | the call's AsyncLocalStorage store: `Principal`, `AuthnPrincipal`, `AuthzDecision` ... |
| `socketConnection` | the `SocketConnection` |

The `route` a policy gets has `Type: 'socket'`, `Path` set to the full name and the handler's `Options`.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@SocketPolicy(policy \| policies[], ...options)` | controller class or handler method | `policy`: a `BasePolicy` class, or a configuration key holding a policy class name; `options`: constructor options of every member | One group (AND inside); several calls are alternatives (OR) |
| `@SocketPolicyGroup(group)` | controller class or handler method | `IPolicyGroup`: `{ Type, Options }[]` | One group whose members carry their own options |
| `@SocketAccess(permission \| permissions[], options?)` | controller class or handler method | `ISocketAccessOptions` (below) | One group: `SocketAccessPolicy` AND the `also` policies; on a subclass it replaces the inherited `@SocketAccess` of that place |

`ISocketAccessOptions`:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `resource` | `SocketResourceExtractor` | type-level ref of each permission | Returns a `ResourceRef` (`{ type, id }`) or a loaded row from the call; `fromPayload(path, type)` reads a payload field |
| `also` | `Class<BasePolicy>[]` | `[]` | More policies in the same group (AND) |
| `domain` | string | `'root'` | The authz domain the rule checks in |
| `allowAnonymous` | boolean | `false` | Let an unauthenticated principal reach the engine |
| `subject` | `'load'` \| `'none'` | `'none'` | `'load'`: settle a conditional allow against the loaded row |
| `fields` | `'filter'` \| `'none'` | `'none'` | `'filter'`: limit the result, or each chunk, to the readable fields |
| `unfilteredInput` | string (a reason) | none | The payload skips authz-http's input field filter |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `BasePolicy` (`@spinajs/http`) | Resolved per handler at registry build with the group's options; lifetime from the class; a string member must name a class registered under `BasePolicy` | none | Your policies; authn-http's `Authenticated`, `NotLoggedPolicy`, `NoTokenAuthPolicy`, `NoImpersonationPolicy`, `MfaSatisfied` (from `@spinajs/authn-http/socket`) | Extend `BasePolicy`, attach with `@SocketPolicy`; for a config-selected policy, `@Injectable(BasePolicy)` and `@SocketPolicy('config.key')` |
| `SocketResourceExtractor` | Not in DI: a function in `@SocketAccess({ resource })` | `fromPayload(path, type)` | Your function | `(call: ISocketPolicyRequest) => ResourceRef \| object \| Promise<...>` |
| `SocketAccessPolicy` | `@NewInstance()`, resolved per handler with its `ISocketAccess` | `SocketAccessPolicy` | Your subclass | Override the protected `decide()`, `load()` (row loading for `subject: 'load'`) or `service()`; keep `@NewInstance()`; `DI.register(Mine).as(SocketAccessPolicy)` before `SocketServer` resolves |
| `SocketPolicyGate` | `SocketPolicyGate` (self), singleton | `SocketPolicyGate` (http's gate, cached per handler) | Your subclass | Override `check(ctx)`; `DI.register(Mine).as(SocketPolicyGate)` |
| `SocketAccessContributor` | `AuthzContributor`, singleton | `SocketAccessContributor` | none | See [Boot checks](#boot-checks); `DI.unregister(SocketAccessContributor)` drops socket permissions from the boot checks |
| `AccessFieldsStage` | `SocketCommandStage`, order 650 | `AccessFieldsStage` | Your stage | Replace as any stage; see [Command pipeline](04-command-pipeline.md#replace-a-built-in-stage) |

### `BasePolicy`: a socket-aware policy

A policy reads the `ISocketPolicyRequest`. `isEnabled(route)` lets one class serve http and sockets: return `false` where it does not apply.

```ts sample
import { BasePolicy, IController, IRoute } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { BaseSocketController, Command, ISocketPolicyRequest, SocketController, SocketPolicy } from '@spinajs/http-socket';

/** Socket clients must speak a recent app version: `io(url, { auth: { appVersion } })`. */
export class MinAppVersionPolicy extends BasePolicy {
  constructor(protected readonly minimum: number = 1) {
    super();
  }

  public isEnabled(route: IRoute, _controller: IController): boolean {
    return (route as unknown as { Type?: string }).Type === 'socket';
  }

  public async execute(req: unknown): Promise<void> {
    const call = req as ISocketPolicyRequest;
    const version = Number(call.socketConnection.handshake.auth.appVersion ?? 0);

    if (!(version >= this.minimum)) {
      throw new Forbidden(`${call.originalUrl} needs app version ${this.minimum} or later`);
    }
  }
}

@SocketController('billing')
@SocketPolicy(MinAppVersionPolicy, 42)
export class BillingSocket extends BaseSocketController {
  @Command('invoices')
  public async invoices() {
    return [];
  }
}
```

### A policy chosen by configuration

A string in `@SocketPolicy` is a configuration key. Its value names a class registered under `BasePolicy`; the registry fails the start with `RouteRegistrationException` when it is missing.

```ts sample
import { Injectable } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { Unauthenticated } from '@spinajs/authz';
import { BaseSocketController, Command, ISocketPolicyRequest, SocketController, SocketPolicy } from '@spinajs/http-socket';

@Injectable(BasePolicy)
export class SignedInPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    if (!(req as ISocketPolicyRequest).storage.Principal.authenticated) {
      throw new Unauthenticated('sign in first');
    }
  }
}

// config: { app: { socket: { adminPolicy: 'SignedInPolicy' } } }; production may name a stricter class
@SocketController('admin')
@SocketPolicy('app.socket.adminPolicy')
export class AdminSocket extends BaseSocketController {
  @Command('stats')
  public async stats() {
    return { connections: 0 };
  }
}
```

### `SocketResourceExtractor`: the resource from connection state

An extractor returns a `{ type, id }` ref or a loaded row. Sockets have no `fromModel`: return a ref, not an unloaded ORM instance, or the engine reads its default field values as the row.

```ts sample
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseSocketController, Command, Connection, SocketAccess, SocketConnection, SocketController, SocketResourceExtractor } from '@spinajs/http-socket';

/** The workspace the connection opened earlier with 'workspace.open'. */
export const currentWorkspace: SocketResourceExtractor = (call) => {
  const id = call.socketConnection.data.workspaceId;
  if (typeof id !== 'string') {
    throw new InvalidArgument('open a workspace first', 'workspaceId');
  }
  return { type: 'workspace', id };
};

@SocketController('workspace')
export class WorkspaceSocket extends BaseSocketController {
  @Command('members')
  @SocketAccess('workspace:read', { resource: currentWorkspace })
  public async members(@Connection() conn: SocketConnection<{ workspaceId?: string }>) {
    return { workspace: conn.data.workspaceId, members: [] };
  }
}
```

## Boot checks

`@SocketAccess` permissions take part in the boot checks (B02) of the domain they check in, through `SocketAccessContributor`:

- a permission the domain does not register fails that domain's boot;
- a rule without a `resource` extractor also declares the permission's resource type, so a type/permission mismatch fails the boot (rule 7). Socket extractors add no type, so a rule with an extractor is not checked for it;
- a domain checks only the socket controllers registered when it boots. `SocketServer.resolve()` warns about rules a booted domain missed; an unregistered permission among them throws `UnknownPermission` at run time (answered `internal`).

## Important behaviour

- Policies run for commands and events, never for `@OnConnect` / `@OnDisconnect` hooks.
- `@SocketAccess` is declared once per place: a second one on the same class or method throws when the module loads. On a subclass, it replaces the inherited `@SocketAccess` group of that place, as `@Access` does.
- Permission names are parsed when the module loads; a malformed name throws then, not on the first call.
- The handler's own rule decides, else the controller's, and that decision is the one in `storage.AuthzDecision`. A call another policy group admitted has no decision; the input filter and `fields: 'filter'` then use the handler rule's domain, else the class rule's, else `root`.
- `allowAnonymous` and `unfilteredInput` apply only to the rule that carries them. A class rule's options do not reach a handler with its own `@SocketAccess`, unlike http's `@AllowAnonymous` and `@UnfilteredInput` on a class.
- A command without `@SocketAccess` is not input-filtered. In authz-http's `reject` write mode, a refused field answers `invalid_argument` with `details { error: 'fields_not_writable', fields }`.
- With `fields: 'filter'`, only a top-level binary result or chunk passes unchanged; nested binary values are filtered like JSON. Without it nothing is stripped from output, `neverRead` included.
- `subject: 'load'` uses the first `ResourceAdapter` of the domain that serves the ref's type and can `load`; with none, the row counts as missing.
- authn-http's `NoSession`, `FreshAuth` and `PendingMfaEnrolment` read `AuthnSession`, which socket calls do not carry: `NoSession` would always pass on a socket. Do not attach them with `@SocketPolicy`.
- Refusals of authn-http policies carry their stable code in `details.error` (`session_required`, `already_authenticated`, `impersonating` ...).

## Best practices

- Put the coarse rule on the class (`@SocketAccess('doc:read')`) and the precise one, with a `resource`, on each handler.
- Use `fields: 'filter'` on every command that returns rows a field-level grant may restrict.
- Prefer `fromPayload('id', 'doc')` over a hand-written extractor for payload ids: it refuses a missing id with `invalid_argument` naming the path.
- Resolve `SocketServer` before `http.start()` so the boot checks see every socket rule.

## Patterns and antipatterns

```ts
// Don't: an anonymous-friendly class rule does not reach a handler with its own rule
@SocketController('docs')
@SocketAccess('doc:read', { allowAnonymous: true })
export class DocsSocket extends BaseSocketController {
  @Command('open')
  @SocketAccess('doc:read', { resource: fromPayload('id', 'doc') })
  public async open(@Payload() req: { id: string }) {}
}

// Do: repeat the option on the rule that decides
@Command('open')
@SocketAccess('doc:read', { resource: fromPayload('id', 'doc'), allowAnonymous: true })
public async open(@Payload() req: { id: string }) {}
```

## Examples

### Read a document with field-level access

```ts sample
import { BaseSocketController, Command, Payload, SocketAccess, SocketController, fromPayload } from '@spinajs/http-socket';

const rows = new Map([['d1', { id: 'd1', title: 'Roadmap', body: 'Q3 plans', salaryBand: 'B3', ownerId: 'u1' }]]);

@SocketController('docs')
@SocketAccess('doc:list')
export class DocsSocket extends BaseSocketController {
  @Command('list')
  public async list() {
    return [...rows.values()].map((r) => ({ id: r.id, title: r.title }));
  }

  // conditional grants ( "owner may read" ) are settled against the loaded row; fields the caller may not read are dropped
  @Command('get', { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } })
  @SocketAccess(['doc:read', 'doc:admin'], { resource: fromPayload('id', 'doc'), subject: 'load', fields: 'filter' })
  public async get(@Payload() req: { id: string }) {
    return rows.get(req.id) ?? null;
  }
}
```

## Related

- [`@spinajs/authz`](../authz/README.md): permissions, decisions, domains, `ResourceAdapter`, boot checks.
- [`@spinajs/http` policies](../http/13-policies.md): `BasePolicy`, `@Policy` semantics and the gate sockets reuse.
- [Handler arguments](03-handler-arguments.md): where the input field filter runs.
- [Command pipeline](04-command-pipeline.md): stages 600 and 650.
